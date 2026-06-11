import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import { authFetch, getAuthToken, getJson, login, setAuthToken, whoami, wsUrlWithTicket } from './api';
import { applyEventToChats, newEntry, normalizeProjects, toFeedEvent } from './lib/feed';
import type { ApprovalTicket, ChatsState, FeedEvent, Project, WsStatus } from './lib/types';
import {
  AnalyticsPanel,
  ApprovalsPanel,
  AutomationPanel,
  MemoryPanel,
  OptimizePanel,
  PluginsPanel,
  SystemPanel,
} from './components/panels';
import { ChatView } from './components/views/chat-view';
import { ActivityView } from './components/views/activity-view';
import { LoginGate } from './components/views/login-gate';
import { NAV_ITEMS, Sidebar, type ViewId } from './components/views/sidebar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';

const FEED_LIMIT = 500;

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [chats, setChats] = useState<ChatsState>({});
  const [input, setInput] = useState('');
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<ViewId>('chat');
  const [pendingApprovals, setPendingApprovals] = useState(0);
  // Bumped to force the active panel to remount + reload on a refresh click.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [optimizeRunning, setOptimizeRunning] = useState(false);

  // ---- Auth (Phase 4) ----
  // authMode is detected from /api/whoami. When 'on' and we have no token, a
  // login form gates the app. The token lives in memory (./api) and is sent on
  // every fetch + the WS ticket. When 'off', no login is shown (current UX).
  const [authMode, setAuthMode] = useState<'off' | 'on' | 'unknown'>('unknown');
  const [authed, setAuthed] = useState(false);
  const [principalName, setPrincipalName] = useState<string | undefined>();
  const [principalRole, setPrincipalRole] = useState<string | null>(null);
  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | undefined>();

  const refreshWhoami = useCallback(async () => {
    try {
      const who = await whoami();
      setAuthMode(who.authMode);
      setPrincipalName(who.principal.displayName);
      setPrincipalRole(who.role);
      // Authed iff auth is off (implicit owner) or we hold a working token.
      setAuthed(who.authMode === 'off' || getAuthToken() !== undefined);
    } catch {
      // A 401 means auth is ON and we are not logged in yet.
      setAuthMode('on');
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void refreshWhoami();
  }, [refreshWhoami]);

  const doLogin = useCallback(async () => {
    setLoginError(undefined);
    try {
      const res = await login(loginUser.trim(), loginPassword);
      setAuthToken(res.token);
      setLoginPassword('');
      await refreshWhoami();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  }, [loginUser, loginPassword, refreshWhoami]);

  const doLogout = useCallback(() => {
    setAuthToken(undefined);
    setAuthed(false);
    void refreshWhoami();
  }, [refreshWhoami]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await authFetch('/api/projects');
      if (!res.ok) throw new Error(`GET /api/projects → ${res.status}`);
      const list = normalizeProjects(await res.json());
      setProjects(list);
      setSelectedId((cur) => (cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? '')));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (authed) void loadProjects();
  }, [loadProjects, authed]);

  useEffect(() => {
    if (!authed) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: number | undefined;

    const connect = async () => {
      if (disposed) return;
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // Mint a short-lived single-use ws-ticket (FIX 3) and attach it as the
      // ?ticket= param so the upgrade authenticates when auth is ON (WebSocket
      // can't set an Authorization header). The long-lived bearer token is never
      // placed in the URL.
      let url: string;
      try {
        url = await wsUrlWithTicket(`${proto}://${window.location.host}/api/ws`);
      } catch {
        setWsStatus('closed');
        if (!disposed) retry = window.setTimeout(() => void connect(), 2000);
        return;
      }
      if (disposed) return;
      ws = new WebSocket(url);
      ws.onopen = () => setWsStatus('open');
      ws.onmessage = (msg: MessageEvent) => {
        if (typeof msg.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          return;
        }
        const ev = toFeedEvent(parsed);
        if (!ev) return;
        setEvents((prev) => [ev, ...prev].slice(0, FEED_LIMIT));
        setChats((prev) => applyEventToChats(prev, ev));
      };
      ws.onclose = () => {
        setWsStatus('closed');
        if (!disposed) retry = window.setTimeout(() => void connect(), 2000);
      };
      ws.onerror = () => ws?.close();
    };

    void connect();
    return () => {
      disposed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      ws?.close();
    };
  }, [authed]);

  // Lightweight poll for the pending-approvals badge so the sidebar count stays
  // current regardless of the active view (the Approvals panel owns the list).
  const loadPendingCount = useCallback(async () => {
    if (!authed || !selectedId) {
      setPendingApprovals(0);
      return;
    }
    try {
      const data = await getJson<{ tickets: ApprovalTicket[] }>(
        `/api/projects/${encodeURIComponent(selectedId)}/approvals?status=pending`,
      );
      setPendingApprovals(data.tickets.length);
    } catch {
      /* badge is best-effort; ignore errors */
    }
  }, [authed, selectedId]);

  useEffect(() => {
    void loadPendingCount();
  }, [loadPendingCount, refreshNonce, view]);

  const transcript = useMemo(() => chats[selectedId] ?? [], [chats, selectedId]);

  const sendGoal = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || !selectedId) return;
    setInput('');
    const now = new Date().toISOString();
    setChats((prev) => {
      const entries = prev[selectedId] ?? [];
      return {
        ...prev,
        [selectedId]: [...entries, newEntry('user', prompt, false, now), newEntry('assistant', 'running…', true, now)],
      };
    });
    try {
      const res = await authFetch(`/api/projects/${encodeURIComponent(selectedId)}/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error(`POST goals → ${res.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setChats((prev) => {
        const entries = prev[selectedId] ?? [];
        const idx = entries.findIndex((e) => e.pending);
        if (idx < 0) return prev;
        const next = entries.slice();
        const cur = next[idx];
        if (cur) next[idx] = { ...cur, text: `request failed: ${msg}`, pending: false };
        return { ...prev, [selectedId]: next };
      });
    }
  }, [input, selectedId]);

  // The optimizer run lives on the Optimize panel; the header "run" action posts
  // the same endpoint and signals the panel to refresh via the refresh nonce.
  const runOptimizeFromHeader = useCallback(async () => {
    if (!selectedId) return;
    setOptimizeRunning(true);
    try {
      const res = await authFetch(`/api/projects/${encodeURIComponent(selectedId)}/optimize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`optimize → ${res.status}`);
      setRefreshNonce((n) => n + 1);
    } catch {
      /* the Optimize panel surfaces its own errors; header action is a shortcut */
    } finally {
      setOptimizeRunning(false);
    }
  }, [selectedId]);

  // Login gate: only shown when auth is ON and we are not authenticated.
  if (authMode === 'on' && !authed) {
    return (
      <>
        <LoginGate
          user={loginUser}
          password={loginPassword}
          error={loginError}
          setUser={setLoginUser}
          setPassword={setLoginPassword}
          onSubmit={() => void doLogin()}
        />
        <Toaster />
      </>
    );
  }

  const selectedProject = projects.find((p) => p.id === selectedId);
  const navItem = NAV_ITEMS.find((n) => n.id === view);
  const viewTitle = navItem?.label ?? 'Chat';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        view={view}
        onViewChange={setView}
        projects={projects}
        selectedId={selectedId}
        onSelectProject={setSelectedId}
        wsStatus={wsStatus}
        pendingApprovals={pendingApprovals}
        authMode={authMode}
        authed={authed}
        principalName={principalName}
        principalRole={principalRole}
        onLogout={doLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <h1 className="text-base font-semibold tracking-tight">{viewTitle}</h1>
          {selectedProject && (
            <Badge variant="secondary" className="font-mono text-xs">
              {selectedProject.name}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            {view === 'optimize' && (
              <Button size="sm" disabled={optimizeRunning || !selectedId} onClick={() => void runOptimizeFromHeader()}>
                <Play /> {optimizeRunning ? 'running…' : 'Run optimizer'}
              </Button>
            )}
            {view !== 'chat' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => (view === 'activity' ? setEvents([]) : setRefreshNonce((n) => n + 1))}
                title={view === 'activity' ? 'Clear feed' : 'Refresh'}
              >
                <RefreshCw /> {view === 'activity' ? 'Clear' : 'Refresh'}
              </Button>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="min-h-0 flex-1">
          {error && view !== 'chat' && (
            <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {view === 'chat' && (
            <ChatView
              transcript={transcript}
              input={input}
              setInput={setInput}
              onSend={() => void sendGoal()}
              canSend={!!selectedId}
            />
          )}
          {view === 'activity' && <ActivityView events={events} />}
          {view === 'analytics' && <AnalyticsPanel key={`an-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
          {view === 'memory' && <MemoryPanel key={`mem-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
          {view === 'approvals' && <ApprovalsPanel key={`ap-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
          {view === 'optimize' && <OptimizePanel key={`op-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
          {view === 'plugins' && <PluginsPanel key={`pl-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
          {view === 'automation' && <AutomationPanel key={`au-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
          {view === 'system' && <SystemPanel key={`sy-${selectedId}-${refreshNonce}`} projectId={selectedId} />}
        </main>
      </div>

      <Toaster />
    </div>
  );
}
