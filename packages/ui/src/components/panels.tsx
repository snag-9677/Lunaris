/**
 * Mission Control panels rebuilt with shadcn/ui primitives. Every fetch URL,
 * method, body and response-handling path is preserved verbatim from the Phase
 * 1-4 implementation; only the presentation changed. They poll on
 * mount/view-activation and on an explicit refresh; the live WS feed stays in
 * App.tsx. Action results/errors surface via sonner toasts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Download,
  Inbox,
  Package,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { authFetch, getJson } from '../api';
import { fmtBytes, fmtTokens, fmtUsd } from '../lib/feed';
import type {
  ApprovalTicket,
  ConfigProposal,
  DoctorReport,
  LeaseInfo,
  LoadedPlugin,
  MemoryEntity,
  MemoryRecord,
  MemoryRelation,
  OptimizerReport,
  ProjectAnalytics,
  QueuedGoal,
  Schedule,
  SnapshotInfo,
  VersionInfo,
} from '../lib/types';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

function reportError(err: unknown): void {
  toast.error(err instanceof Error ? err.message : String(err));
}

/* ---------- small shared presentation helpers ---------- */

function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-1 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground', className)}>
      {children}
    </div>
  );
}

/** A scrollable body shared by every panel so they fill the content area. */
function PanelBody({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
      <div className="space-y-4 p-4">{children}</div>
    </ScrollArea>
  );
}

const memBadgeVariant: Record<string, BadgeProps['variant']> = {
  semantic: 'info',
  procedural: 'success',
  episodic: 'warning',
};

const queueBadgeVariant: Record<string, BadgeProps['variant']> = {
  queued: 'warning',
  done: 'success',
  leased: 'info',
  failed: 'destructive',
  dead: 'destructive',
};

const doctorBadgeVariant: Record<string, BadgeProps['variant']> = {
  ok: 'success',
  behind: 'warning',
  ahead: 'info',
  missing: 'destructive',
};

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

  if (!data && !error) return <PanelEmpty>loading…</PanelEmpty>;

  return (
    <PanelBody>
      {error && <ErrorNote message={error} />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>model</TableHead>
                    <TableHead className="text-right">calls</TableHead>
                    <TableHead className="text-right">in</TableHead>
                    <TableHead className="text-right">out</TableHead>
                    <TableHead className="text-right">cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byModel.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        no model usage yet
                      </TableCell>
                    </TableRow>
                  )}
                  {data.byModel.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="font-mono text-xs">{m.model}</TableCell>
                      <TableCell className="text-right tabular-nums">{m.calls}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(m.inputTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtTokens(m.outputTokens)}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{fmtUsd(m.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </PanelBody>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-primary">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
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
    <PanelBody>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(query);
        }}
      >
        <Input
          value={query}
          placeholder="search memory…"
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" size="sm">
          search
        </Button>
      </form>
      {error && <ErrorNote message={error} />}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div>
          <SectionTitle>records ({records.length})</SectionTitle>
          {loaded && records.length === 0 && <PanelEmpty>no memory records</PanelEmpty>}
          <div className="space-y-2">
            {records.map((r) => (
              <Card key={r.id}>
                <CardContent className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={memBadgeVariant[r.type] ?? 'muted'}>{r.type}</Badge>
                    <span className="text-xs text-muted-foreground">conf {r.confidence.toFixed(2)}</span>
                    <span className="text-xs text-muted-foreground">str {r.strength.toFixed(2)}</span>
                    {r.tainted && <span className="text-xs text-destructive">untrusted</span>}
                  </div>
                  <div className="mt-2 whitespace-pre-wrap break-words text-sm">{r.statement}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
        <div>
          <SectionTitle>entity graph ({entities.length})</SectionTitle>
          {loaded && communities.length === 0 && <PanelEmpty>no entities yet</PanelEmpty>}
          <div className="space-y-3">
            {communities.map(([cid, ents]) => (
              <div key={cid}>
                <div className="mb-1.5 text-xs text-[oklch(0.78_0.12_300)]">
                  {cid === 'ungrouped' ? 'ungrouped' : `community ${cid.slice(1)}`}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ents.map((e) => (
                    <span
                      key={e.name}
                      title={e.kind}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs"
                    >
                      {e.name}
                      {relCount.has(e.name) && (
                        <span className="rounded-full bg-background px-1.5 text-[10px] text-primary">
                          {relCount.get(e.name)}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PanelBody>
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
        const res = await authFetch(`/api/approvals/${encodeURIComponent(ticketId)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved, by: 'ui', projectId }),
        });
        if (!res.ok) throw new Error(`resolve → ${res.status}`);
        setTickets((prev) => prev.filter((t) => t.ticketId !== ticketId));
        toast.success(approved ? 'Approved' : 'Denied');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        reportError(err);
      } finally {
        setBusy(undefined);
      }
    },
    [projectId],
  );

  return (
    <PanelBody>
      {error && <ErrorNote message={error} />}
      {loaded && tickets.length === 0 && (
        <PanelEmpty>
          <Inbox className="mx-auto mb-2 h-6 w-6 opacity-50" />
          no pending approvals
        </PanelEmpty>
      )}
      <div className="space-y-3">
        {tickets.map((t) => (
          <Card key={t.ticketId}>
            <CardContent className="p-3">
              <div className="flex items-center gap-2">
                <Badge variant="warning">{t.tool}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{t.ticketId.slice(0, 8)}</span>
              </div>
              <div className="mt-2 text-sm">{t.reason}</div>
              {t.args !== undefined && t.args !== null && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-secondary px-2.5 py-2 font-mono text-xs text-muted-foreground">
                  {JSON.stringify(t.args)}
                </pre>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  variant="success"
                  size="sm"
                  disabled={busy === t.ticketId}
                  onClick={() => void resolve(t.ticketId, true)}
                >
                  <CheckCircle2 /> approve
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy === t.ticketId}
                  onClick={() => void resolve(t.ticketId, false)}
                >
                  <XCircle /> deny
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </PanelBody>
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
      const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/optimize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`optimize → ${res.status}`);
      const r = (await res.json()) as OptimizerReport;
      setReport(r);
      setProposals(r.proposals);
      setError(undefined);
      toast.success(`Optimizer ran — ${r.proposals.length} proposal(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reportError(err);
    } finally {
      setRunning(false);
    }
  }, [projectId]);

  const resolve = useCallback(
    async (id: string, approved: boolean) => {
      setBusy(id);
      try {
        const res = await authFetch(`/api/proposals/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved, projectId }),
        });
        if (!res.ok) throw new Error(`resolve → ${res.status}`);
        const updated = (await res.json()) as ConfigProposal;
        setProposals((prev) => prev.map((p) => (p.id === id ? updated : p)));
        toast.success(approved ? 'Proposal approved' : 'Proposal rejected');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        reportError(err);
      } finally {
        setBusy(undefined);
      }
    },
    [projectId],
  );

  return (
    <PanelBody>
      {error && <ErrorNote message={error} />}
      {report && (
        <>
          <SectionTitle>success rate by model</SectionTitle>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>class/role/model</TableHead>
                    <TableHead className="text-right">n</TableHead>
                    <TableHead className="text-right">success</TableHead>
                    <TableHead className="text-right">cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.stats.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        no task outcomes yet
                      </TableCell>
                    </TableRow>
                  )}
                  {report.stats.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className="font-mono text-xs">{`${s.taskClass}/${s.role}/${s.model}`}</TableCell>
                      <TableCell className="text-right tabular-nums">{`${s.successes}/${s.n}`}</TableCell>
                      <TableCell className="text-right tabular-nums">{`${(s.successRate * 100).toFixed(0)}%`}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{fmtUsd(s.avgCostUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <SectionTitle className="mt-1">routing suggestions</SectionTitle>
          {report.routing.length === 0 && <PanelEmpty>none yet — need more pulls per arm</PanelEmpty>}
          <div className="space-y-2">
            {report.routing.map((s) => (
              <Card key={s.taskClass}>
                <CardContent className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="info">{s.taskClass}</Badge>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono text-xs text-info">{s.recommendedModel}</span>
                    <span className="text-xs text-muted-foreground">
                      conf {(s.confidence * 100).toFixed(0)}% · n={s.basedOnN}
                    </span>
                  </div>
                  <div className="mt-1.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {s.rationale}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {report.notes.length > 0 && (
            <div className="space-y-1 border-t border-border pt-3">
              {report.notes.map((n, i) => (
                <div key={i} className="text-xs text-muted-foreground">
                  {n}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <SectionTitle className="mt-1">proposals ({proposals.length})</SectionTitle>
      {proposals.length === 0 && <PanelEmpty>no proposals — run the optimizer</PanelEmpty>}
      <div className="space-y-3">
        {proposals.map((p) => (
          <Card key={p.id}>
            <CardContent className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={p.kind === 'routing' ? 'info' : 'default'}>{p.kind}</Badge>
                <span className="text-xs text-muted-foreground">{p.status}</span>
                <span className="text-xs text-muted-foreground">conf {(p.confidence * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-2 text-sm">{p.title}</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{p.detail}</div>
              {p.diff && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-secondary px-2.5 py-2 font-mono text-xs text-muted-foreground">
                  {p.diff}
                </pre>
              )}
              {p.status === 'pending' && (
                <div className="mt-3 flex gap-2">
                  <Button variant="success" size="sm" disabled={busy === p.id} onClick={() => void resolve(p.id, true)}>
                    <CheckCircle2 /> approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy === p.id}
                    onClick={() => void resolve(p.id, false)}
                  >
                    <XCircle /> reject
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </PanelBody>
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
        const res = await authFetch(
          `/api/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(id)}/${action}`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`${action} → ${res.status}`);
        const data = (await res.json()) as { plugins: LoadedPlugin[] };
        setPlugins(data.plugins);
        toast.success(`${id} ${enable ? 'enabled' : 'disabled'}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        reportError(err);
      } finally {
        setBusy(undefined);
      }
    },
    [projectId],
  );

  return (
    <PanelBody>
      {error && <ErrorNote message={error} />}
      {loaded && plugins.length === 0 && <PanelEmpty>no plugins under .lunaris/plugins</PanelEmpty>}
      <div className="space-y-2">
        {plugins.map((p) => (
          <Card key={p.manifest.id}>
            <CardContent className="flex items-center gap-3 p-3">
              <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.manifest.id}</span>
                  <span className="text-xs text-muted-foreground">v{p.manifest.version}</span>
                </div>
                {p.manifest.description && (
                  <span className="truncate text-xs text-muted-foreground">{p.manifest.description}</span>
                )}
              </div>
              <Button
                variant={p.enabled ? 'success' : 'outline'}
                size="sm"
                disabled={busy === p.manifest.id}
                onClick={() => void toggle(p.manifest.id, !p.enabled)}
              >
                {p.enabled ? 'enabled' : 'disabled'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </PanelBody>
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
      const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cron: cron.trim(), prompt: prompt.trim() }),
      });
      if (!res.ok) throw new Error(`add schedule → ${res.status}`);
      setPrompt('');
      await load();
      toast.success('Schedule added');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reportError(err);
    }
  }, [projectId, cron, prompt, load]);

  const removeSchedule = useCallback(
    async (id: string) => {
      try {
        const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`remove → ${res.status}`);
        setSchedules((prev) => prev.filter((s) => s.id !== id));
        toast.success('Schedule removed');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        reportError(err);
      }
    },
    [projectId],
  );

  return (
    <PanelBody>
      {error && <ErrorNote message={error} />}
      <SectionTitle>schedules ({schedules.length})</SectionTitle>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void addSchedule();
        }}
      >
        <Input
          value={cron}
          placeholder="cron (5-field)"
          onChange={(e) => setCron(e.target.value)}
          className="font-mono sm:w-40 sm:shrink-0"
        />
        <Input
          value={prompt}
          placeholder="prompt for the scheduled goal"
          onChange={(e) => setPrompt(e.target.value)}
          className="sm:flex-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!projectId || cron.trim().length === 0 || prompt.trim().length === 0}
        >
          <Plus /> add
        </Button>
      </form>
      {loaded && schedules.length === 0 && <PanelEmpty>no schedules</PanelEmpty>}
      <div className="space-y-2">
        {schedules.map((s) => (
          <Card key={s.id}>
            <CardContent className="flex items-center gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <Badge variant={s.enabled ? 'success' : 'muted'} className="font-mono">
                  {s.cron}
                </Badge>
                <span className="truncate text-sm">
                  {s.prompt ?? (s.templateId ? `template:${s.templateId}` : '')}
                </span>
                {s.nextRunAt && <span className="text-xs text-muted-foreground">next {s.nextRunAt}</span>}
              </div>
              <Button variant="destructive" size="sm" onClick={() => void removeSchedule(s.id)}>
                <Trash2 /> remove
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <SectionTitle className="mt-1">goal queue ({goals.length})</SectionTitle>
      {loaded && goals.length === 0 && <PanelEmpty>queue is empty</PanelEmpty>}
      <div className="space-y-2">
        {goals.map((g) => (
          <Card key={g.id}>
            <CardContent className="flex items-center gap-2 p-3">
              <Badge variant={queueBadgeVariant[g.status] ?? 'muted'}>{g.status}</Badge>
              <span className="text-xs text-muted-foreground">p{g.priority}</span>
              <span className="text-xs text-muted-foreground">{g.source}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{g.prompt}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </PanelBody>
  );
}

/* ---------- System: version + schema doctor, lease, snapshots, export ---------- */

export function SystemPanel({ projectId }: { projectId: string }) {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [lease, setLease] = useState<LeaseInfo | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const ver = await getJson<{ version: VersionInfo; doctor: DoctorReport }>('/api/version');
      setVersion(ver.version);
      setDoctor(ver.doctor);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    if (!projectId) {
      setSnapshots([]);
      setLease(null);
      return;
    }
    try {
      const snaps = await getJson<{ snapshots: SnapshotInfo[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/snapshots`,
      );
      setSnapshots(snaps.snapshots);
    } catch {
      setSnapshots([]);
    }
    // The lease holder is read off the global doctor's version route; a
    // dedicated lease endpoint isn't required for display, so we surface what
    // /api/version reports plus the per-project snapshots. Lease holder info is
    // only shown when present in a future /lease route; left null otherwise.
    setLease(null);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createSnapshot = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'full' }),
      });
      if (!res.ok) throw new Error(`snapshot → ${res.status}`);
      const info = (await res.json()) as SnapshotInfo;
      setSnapshots((prev) => [info, ...prev]);
      toast.success(`Created snapshot ${info.id.slice(0, 12)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reportError(err);
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  const restoreDryRun = useCallback(
    async (snapshotId: string) => {
      if (!projectId) return;
      setBusy(true);
      try {
        const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ snapshotId, dryRun: true }),
        });
        if (!res.ok) throw new Error(`restore → ${res.status}`);
        const result = (await res.json()) as { restored: string[]; dryRun: boolean };
        toast.success(`Dry run: would restore ${result.restored.length} file(s)`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        reportError(err);
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const exportBundle = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`export → ${res.status}`);
      const out = (await res.json()) as { outPath: string };
      toast.success(`Exported bundle → ${out.outPath}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reportError(err);
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  return (
    <PanelBody>
      {error && <ErrorNote message={error} />}
      <SectionTitle>harness {version ? `v${version.harness}` : '…'}</SectionTitle>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>store</TableHead>
                <TableHead className="text-right">version</TableHead>
                <TableHead className="text-right">expected</TableHead>
                <TableHead>status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(!doctor || doctor.stores.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    no stores found
                  </TableCell>
                </TableRow>
              )}
              {doctor?.stores.map((s) => (
                <TableRow key={s.store}>
                  <TableCell className="font-mono text-xs">{s.store}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.version ?? '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.expected ?? '-'}</TableCell>
                  <TableCell>
                    <Badge variant={doctorBadgeVariant[s.status] ?? 'muted'}>{s.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle className="mt-1">lease</SectionTitle>
      {lease ? (
        <div className="font-mono text-sm">
          holder {lease.holderId.slice(0, 12)} · node {lease.nodeId} · epoch {lease.epoch}
        </div>
      ) : (
        <PanelEmpty>no live lease for this project</PanelEmpty>
      )}

      <SectionTitle className="mt-1">snapshots ({snapshots.length})</SectionTitle>
      <div className="flex gap-2">
        <Button variant="success" size="sm" disabled={busy || !projectId} onClick={() => void createSnapshot()}>
          <Plus /> create snapshot
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !projectId} onClick={() => void exportBundle()}>
          <Download /> export bundle
        </Button>
      </div>
      {snapshots.length === 0 && <PanelEmpty>no snapshots</PanelEmpty>}
      <div className="space-y-2">
        {snapshots.map((s) => (
          <Card key={s.id}>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              <Badge variant="success">{s.kind}</Badge>
              <span className="font-mono text-xs text-info">{s.id.slice(0, 12)}</span>
              <span className="text-xs text-muted-foreground">{fmtBytes(s.bytes)}</span>
              <span className="text-xs text-muted-foreground">{s.createdAt}</span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={busy}
                onClick={() => void restoreDryRun(s.id)}
              >
                restore (dry-run)
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </PanelBody>
  );
}
