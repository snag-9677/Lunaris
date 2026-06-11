/**
 * Phase 2 Mission Control panels: Analytics, Memory (records + entity graph),
 * and an Approvals inbox. All dependency-free: plain React + fetch. They are
 * polled on mount/tab-activation and on an explicit refresh; the live WS feed
 * stays in App.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

/* ---------- shared types (mirror @lunaris/core; UI stays dep-free) ---------- */

interface ModelUsageRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface ProjectAnalytics {
  projectId: string;
  since: string;
  goals: { total: number; done: number; failed: number; running: number };
  llm: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  byModel: ModelUsageRow[];
  tools: { calls: number; failures: number };
}

interface MemoryRecord {
  id: string;
  type: string;
  statement: string;
  entities: string[];
  confidence: number;
  strength: number;
  tainted?: boolean;
}

interface MemoryEntity {
  name: string;
  kind?: string;
  communityId?: number;
}

interface MemoryRelation {
  from: string;
  to: string;
  rel: string;
  recordId: string;
}

interface ApprovalTicket {
  ticketId: string;
  projectId: string;
  tool: string;
  args: unknown;
  reason: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'denied' | 'stale';
}

/* ---------- fetch helper ---------- */

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/* ---------- Analytics ---------- */

export function AnalyticsPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectAnalytics | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      setData(await getJson<ProjectAnalytics>(`/api/projects/${encodeURIComponent(projectId)}/analytics`));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const successRate = useMemo(() => {
    if (!data) return 0;
    const closed = data.goals.done + data.goals.failed;
    return closed > 0 ? Math.round((data.goals.done / closed) * 100) : 0;
  }, [data]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span>analytics</span>
        <button type="button" onClick={() => void load()} disabled={loading}>
          ↻
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="empty">loading…</div>}
      {data && (
        <div className="panel-body">
          <div className="kpis">
            <Kpi label="goals" value={String(data.goals.total)} sub={`${data.goals.running} running`} />
            <Kpi label="success" value={`${successRate}%`} sub={`${data.goals.done}✓ ${data.goals.failed}✗`} />
            <Kpi label="cost" value={fmtUsd(data.llm.costUsd)} sub={`${data.llm.calls} calls`} />
            <Kpi
              label="tokens"
              value={fmtTokens(data.llm.inputTokens + data.llm.outputTokens)}
              sub={`${fmtTokens(data.llm.inputTokens)} in / ${fmtTokens(data.llm.outputTokens)} out`}
            />
            <Kpi label="tools" value={String(data.tools.calls)} sub={`${data.tools.failures} failed`} />
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>model</th>
                <th className="num">calls</th>
                <th className="num">in</th>
                <th className="num">out</th>
                <th className="num">cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    no model usage yet
                  </td>
                </tr>
              )}
              {data.byModel.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td className="num">{m.calls}</td>
                  <td className="num">{fmtTokens(m.inputTokens)}</td>
                  <td className="num">{fmtTokens(m.outputTokens)}</td>
                  <td className="num">{fmtUsd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/* ---------- Memory ---------- */

export function MemoryPanel({ projectId }: { projectId: string }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [entities, setEntities] = useState<MemoryEntity[]>([]);
  const [relations, setRelations] = useState<MemoryRelation[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (q: string) => {
      if (!projectId) return;
      try {
        const search = q.trim().length > 0 ? `?q=${encodeURIComponent(q.trim())}` : '';
        const [mem, graph] = await Promise.all([
          getJson<{ records: MemoryRecord[] }>(`/api/projects/${encodeURIComponent(projectId)}/memory${search}`),
          getJson<{ entities: MemoryEntity[]; relations: MemoryRelation[] }>(
            `/api/projects/${encodeURIComponent(projectId)}/memory/graph`,
          ),
        ]);
        setRecords(mem.records);
        setEntities(graph.entities);
        setRelations(graph.relations);
        setError(undefined);
        setLoaded(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  // Group entities by community for a dependency-free "graph" rendering.
  const communities = useMemo(() => {
    const byId = new Map<string, MemoryEntity[]>();
    for (const e of entities) {
      const key = e.communityId !== undefined ? `c${e.communityId}` : 'ungrouped';
      const arr = byId.get(key) ?? [];
      arr.push(e);
      byId.set(key, arr);
    }
    return [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entities]);

  const relCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of relations) {
      m.set(r.from, (m.get(r.from) ?? 0) + 1);
      m.set(r.to, (m.get(r.to) ?? 0) + 1);
    }
    return m;
  }, [relations]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span>memory</span>
        <form
          className="mem-search"
          onSubmit={(e) => {
            e.preventDefault();
            void load(query);
          }}
        >
          <input
            type="text"
            value={query}
            placeholder="search memory…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" onClick={() => void load(query)}>
            ↻
          </button>
        </form>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel-body mem-body">
        <div className="mem-records">
          <div className="mem-subhead">records ({records.length})</div>
          {loaded && records.length === 0 && <div className="empty">no memory records</div>}
          {records.map((r) => (
            <div key={r.id} className="mem-record">
              <div className="mem-record-top">
                <span className={`badge mem-${r.type}`}>{r.type}</span>
                <span className="mem-meta">conf {r.confidence.toFixed(2)}</span>
                <span className="mem-meta">str {r.strength.toFixed(2)}</span>
                {r.tainted && <span className="mem-taint">untrusted</span>}
              </div>
              <div className="mem-statement">{r.statement}</div>
            </div>
          ))}
        </div>
        <div className="mem-graph">
          <div className="mem-subhead">entity graph ({entities.length})</div>
          {loaded && communities.length === 0 && <div className="empty">no entities yet</div>}
          {communities.map(([cid, ents]) => (
            <div key={cid} className="community">
              <div className="community-head">{cid === 'ungrouped' ? 'ungrouped' : `community ${cid.slice(1)}`}</div>
              <div className="community-nodes">
                {ents.map((e) => (
                  <span key={e.name} className="node" title={e.kind}>
                    {e.name}
                    {relCount.has(e.name) && <span className="node-deg">{relCount.get(e.name)}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Approvals ---------- */

export function ApprovalsPanel({ projectId }: { projectId: string }) {
  const [tickets, setTickets] = useState<ApprovalTicket[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await getJson<{ tickets: ApprovalTicket[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/approvals?status=pending`,
      );
      setTickets(data.tickets);
      setError(undefined);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (ticketId: string, approved: boolean) => {
      setBusy(ticketId);
      try {
        const res = await fetch(`/api/approvals/${encodeURIComponent(ticketId)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved, by: 'ui', projectId }),
        });
        if (!res.ok) throw new Error(`resolve → ${res.status}`);
        setTickets((prev) => prev.filter((t) => t.ticketId !== ticketId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(undefined);
      }
    },
    [projectId],
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <span>approvals inbox</span>
        <button type="button" onClick={() => void load()}>
          ↻
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel-body">
        {loaded && tickets.length === 0 && <div className="empty">no pending approvals</div>}
        {tickets.map((t) => (
          <div key={t.ticketId} className="ticket">
            <div className="ticket-top">
              <span className="badge ns-tool">{t.tool}</span>
              <span className="ticket-id">{t.ticketId.slice(0, 8)}</span>
            </div>
            <div className="ticket-reason">{t.reason}</div>
            {t.args !== undefined && t.args !== null && (
              <pre className="ticket-args">{JSON.stringify(t.args)}</pre>
            )}
            <div className="ticket-actions">
              <button
                type="button"
                className="approve"
                disabled={busy === t.ticketId}
                onClick={() => void resolve(t.ticketId, true)}
              >
                approve
              </button>
              <button
                type="button"
                className="deny"
                disabled={busy === t.ticketId}
                onClick={() => void resolve(t.ticketId, false)}
              >
                deny
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
