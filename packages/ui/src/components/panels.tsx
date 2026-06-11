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

/* ---------- Phase 3 shared types ---------- */

interface OutcomeStats {
  key: string;
  taskClass: string;
  role: string;
  model: string;
  n: number;
  successes: number;
  successRate: number;
  avgCostUsd: number;
}

interface RoutingSuggestion {
  taskClass: string;
  recommendedModel: string;
  rationale: string;
  confidence: number;
  basedOnN: number;
}

interface ConfigProposal {
  id: string;
  projectId: string;
  kind: 'routing' | 'capability' | 'prompt';
  title: string;
  detail: string;
  diff?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  confidence: number;
}

interface OptimizerReport {
  projectId: string;
  generatedAt: string;
  stats: OutcomeStats[];
  routing: RoutingSuggestion[];
  proposals: ConfigProposal[];
  notes: string[];
}

interface LoadedPlugin {
  manifest: { id: string; version: string; description?: string };
  root: string;
  enabled: boolean;
}

interface Schedule {
  id: string;
  projectId: string;
  cron: string;
  prompt?: string;
  templateId?: string;
  enabled: boolean;
  nextRunAt?: string;
}

interface QueuedGoal {
  id: string;
  projectId: string;
  prompt: string;
  priority: number;
  status: string;
  source: string;
  attempts: number;
  maxAttempts: number;
  goalId?: string;
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

/* ---------- Optimize ---------- */

export function OptimizePanel({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<OptimizerReport | null>(null);
  const [proposals, setProposals] = useState<ConfigProposal[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();

  const loadProposals = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await getJson<{ proposals: ConfigProposal[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/proposals`,
      );
      setProposals(data.proposals);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  const runOptimize = useCallback(async () => {
    if (!projectId) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/optimize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`optimize → ${res.status}`);
      const r = (await res.json()) as OptimizerReport;
      setReport(r);
      setProposals(r.proposals);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [projectId]);

  const resolve = useCallback(
    async (id: string, approved: boolean) => {
      setBusy(id);
      try {
        const res = await fetch(`/api/proposals/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved, projectId }),
        });
        if (!res.ok) throw new Error(`resolve → ${res.status}`);
        const updated = (await res.json()) as ConfigProposal;
        setProposals((prev) => prev.map((p) => (p.id === id ? updated : p)));
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
        <span>optimize</span>
        <button type="button" onClick={() => void runOptimize()} disabled={running || !projectId}>
          {running ? 'running…' : 'run optimizer'}
        </button>
        <button type="button" onClick={() => void loadProposals()}>
          ↻
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel-body">
        {report && (
          <>
            <div className="mem-subhead">success rate by model</div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>class/role/model</th>
                  <th className="num">n</th>
                  <th className="num">success</th>
                  <th className="num">cost</th>
                </tr>
              </thead>
              <tbody>
                {report.stats.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      no task outcomes yet
                    </td>
                  </tr>
                )}
                {report.stats.map((s) => (
                  <tr key={s.key}>
                    <td>{`${s.taskClass}/${s.role}/${s.model}`}</td>
                    <td className="num">{`${s.successes}/${s.n}`}</td>
                    <td className="num">{`${(s.successRate * 100).toFixed(0)}%`}</td>
                    <td className="num">{fmtUsd(s.avgCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mem-subhead" style={{ marginTop: 14 }}>
              routing suggestions
            </div>
            {report.routing.length === 0 && <div className="empty">none yet — need more pulls per arm</div>}
            {report.routing.map((s) => (
              <div key={s.taskClass} className="suggestion">
                <div className="suggestion-top">
                  <span className="badge ns-llm">{s.taskClass}</span>
                  <span className="suggestion-arrow">→</span>
                  <span className="meta model">{s.recommendedModel}</span>
                  <span className="mem-meta">conf {(s.confidence * 100).toFixed(0)}% · n={s.basedOnN}</span>
                </div>
                <div className="suggestion-why">{s.rationale}</div>
              </div>
            ))}

            {report.notes.length > 0 && (
              <div className="opt-notes">
                {report.notes.map((n, i) => (
                  <div key={i} className="opt-note">
                    {n}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mem-subhead" style={{ marginTop: report ? 14 : 0 }}>
          proposals ({proposals.length})
        </div>
        {proposals.length === 0 && <div className="empty">no proposals — run the optimizer</div>}
        {proposals.map((p) => (
          <div key={p.id} className="ticket">
            <div className="ticket-top">
              <span className={`badge ns-${p.kind === 'routing' ? 'llm' : 'goal'}`}>{p.kind}</span>
              <span className="ticket-id">{p.status}</span>
              <span className="mem-meta">conf {(p.confidence * 100).toFixed(0)}%</span>
            </div>
            <div className="ticket-reason">{p.title}</div>
            <div className="proposal-detail">{p.detail}</div>
            {p.diff && <pre className="ticket-args">{p.diff}</pre>}
            {p.status === 'pending' && (
              <div className="ticket-actions">
                <button type="button" className="approve" disabled={busy === p.id} onClick={() => void resolve(p.id, true)}>
                  approve
                </button>
                <button type="button" className="deny" disabled={busy === p.id} onClick={() => void resolve(p.id, false)}>
                  reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Plugins ---------- */

export function PluginsPanel({ projectId }: { projectId: string }) {
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await getJson<{ plugins: LoadedPlugin[] }>(`/api/projects/${encodeURIComponent(projectId)}/plugins`);
      setPlugins(data.plugins);
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

  const toggle = useCallback(
    async (id: string, enable: boolean) => {
      setBusy(id);
      try {
        const action = enable ? 'enable' : 'disable';
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(id)}/${action}`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`${action} → ${res.status}`);
        const data = (await res.json()) as { plugins: LoadedPlugin[] };
        setPlugins(data.plugins);
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
        <span>plugins</span>
        <button type="button" onClick={() => void load()}>
          ↻
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel-body">
        {loaded && plugins.length === 0 && <div className="empty">no plugins under .lunaris/plugins</div>}
        {plugins.map((p) => (
          <div key={p.manifest.id} className="plugin-row">
            <div className="plugin-info">
              <span className="plugin-id">{p.manifest.id}</span>
              <span className="mem-meta">v{p.manifest.version}</span>
              {p.manifest.description && <span className="plugin-desc">{p.manifest.description}</span>}
            </div>
            <button
              type="button"
              className={p.enabled ? 'toggle on' : 'toggle off'}
              disabled={busy === p.manifest.id}
              onClick={() => void toggle(p.manifest.id, !p.enabled)}
            >
              {p.enabled ? 'enabled' : 'disabled'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Automation: schedules + goal queue ---------- */

export function AutomationPanel({ projectId }: { projectId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [goals, setGoals] = useState<QueuedGoal[]>([]);
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [sched, queue] = await Promise.all([
        getJson<{ schedules: Schedule[] }>(`/api/projects/${encodeURIComponent(projectId)}/schedules`),
        getJson<{ goals: QueuedGoal[] }>(`/api/projects/${encodeURIComponent(projectId)}/queue`),
      ]);
      setSchedules(sched.schedules);
      setGoals(queue.goals);
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

  const addSchedule = useCallback(async () => {
    if (!projectId || cron.trim().length === 0 || prompt.trim().length === 0) return;
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cron: cron.trim(), prompt: prompt.trim() }),
      });
      if (!res.ok) throw new Error(`add schedule → ${res.status}`);
      setPrompt('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, cron, prompt, load]);

  const removeSchedule = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`remove → ${res.status}`);
        setSchedules((prev) => prev.filter((s) => s.id !== id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId],
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <span>automation</span>
        <button type="button" onClick={() => void load()}>
          ↻
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel-body">
        <div className="mem-subhead">schedules ({schedules.length})</div>
        <form
          className="sched-add"
          onSubmit={(e) => {
            e.preventDefault();
            void addSchedule();
          }}
        >
          <input type="text" value={cron} placeholder="cron (5-field)" onChange={(e) => setCron(e.target.value)} />
          <input
            type="text"
            value={prompt}
            placeholder="prompt for the scheduled goal"
            onChange={(e) => setPrompt(e.target.value)}
          />
          <button type="submit" disabled={!projectId || cron.trim().length === 0 || prompt.trim().length === 0}>
            add
          </button>
        </form>
        {loaded && schedules.length === 0 && <div className="empty">no schedules</div>}
        {schedules.map((s) => (
          <div key={s.id} className="sched-row">
            <div className="sched-info">
              <span className={`badge ${s.enabled ? 'ns-task' : ''}`}>{s.cron}</span>
              <span className="sched-prompt">{s.prompt ?? (s.templateId ? `template:${s.templateId}` : '')}</span>
              {s.nextRunAt && <span className="mem-meta">next {s.nextRunAt}</span>}
            </div>
            <button type="button" className="deny" onClick={() => void removeSchedule(s.id)}>
              remove
            </button>
          </div>
        ))}

        <div className="mem-subhead" style={{ marginTop: 14 }}>
          goal queue ({goals.length})
        </div>
        {loaded && goals.length === 0 && <div className="empty">queue is empty</div>}
        {goals.map((g) => (
          <div key={g.id} className="queue-row">
            <span className={`badge queue-${g.status}`}>{g.status}</span>
            <span className="mem-meta">p{g.priority}</span>
            <span className="mem-meta">{g.source}</span>
            <span className="queue-prompt">{g.prompt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
