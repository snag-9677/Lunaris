import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AnalyticsPanel,
  ApprovalsPanel,
  AutomationPanel,
  MemoryPanel,
  OptimizePanel,
  PluginsPanel,
  SystemPanel,
} from './components/panels.js';
import { authFetch, getAuthToken, login, setAuthToken, whoami, wsUrlWithTicket } from './api.js';

type RightTab = 'feed' | 'analytics' | 'memory' | 'approvals' | 'optimize' | 'plugins' | 'automation' | 'system';

/* ---------- types (mirror of @lunaris/core EventEnvelope; UI stays dep-free) ---------- */

interface FeedEvent {
  eventId: string;
  ts: string;
  projectId: string;
  kind: string;
  taskId?: string;
  agentId?: string;
  payload: unknown;
}

interface Project {
  id: string;
  name: string;
}

interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending: boolean;
  ts: string;
}

type ChatsState = Record<string, ChatEntry[]>;
type WsStatus = 'connecting' | 'open' | 'closed';

/* ---------- payload extraction helpers ---------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function pickString(obj: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(obj: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function extractModel(payload: unknown): string | undefined {
  return (
    pickString(payload, 'model') ??
    pickString(isRecord(payload) ? payload['request'] : undefined, 'model')
  );
}

function extractTool(payload: unknown, kind: string): string | undefined {
  if (!kind.startsWith('tool')) return pickString(payload, 'tool');
  return pickString(payload, 'tool', 'name');
}

function extractCost(payload: unknown): number | undefined {
  return (
    pickNumber(payload, 'costUsd', 'cost') ??
    pickNumber(isRecord(payload) ? payload['usage'] : undefined, 'costUsd')
  );
}

function extractText(payload: unknown): string | undefined {
  return pickString(payload, 'text', 'summary', 'content', 'response', 'output', 'message');
}

function toFeedEvent(v: unknown): FeedEvent | null {
  if (!isRecord(v)) return null;
  const eventId = pickString(v, 'eventId');
  const ts = pickString(v, 'ts');
  const projectId = pickString(v, 'projectId');
  const kind = pickString(v, 'kind');
  if (!eventId || !ts || !projectId || !kind) return null;
  return {
    eventId,
    ts,
    projectId,
    kind,
    taskId: pickString(v, 'taskId'),
    agentId: pickString(v, 'agentId'),
    payload: v['payload'],
  };
}

function normalizeProjects(data: unknown): Project[] {
  const arr: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data['projects'])
      ? (data['projects'] as unknown[])
      : [];
  const out: Project[] = [];
  for (const item of arr) {
    const id = pickString(item, 'id', 'projectId');
    if (!id) continue;
    out.push({ id, name: pickString(item, 'name') ?? id });
  }
  return out;
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function newEntry(role: ChatEntry['role'], text: string, pending: boolean, ts: string): ChatEntry {
  return { id: crypto.randomUUID(), role, text, pending, ts };
}

function hasRecentUserText(entries: ChatEntry[], text: string): boolean {
  return entries.slice(-6).some((e) => e.role === 'user' && e.text === text);
}

/**
 * Transcript assembly (Phase 1, no token streaming):
 * - chat.message → append row
 * - goal.created → user row (deduped against optimistic local echo) + 'running…' placeholder
 * - llm.call     → resolves the placeholder when its payload carries final text
 * - task.end     → always resolves the placeholder (payload text/summary if present)
 */
function applyEventToChats(chats: ChatsState, ev: FeedEvent): ChatsState {
  const entries = chats[ev.projectId] ?? [];

  if (ev.kind === 'chat.message') {
    const text = extractText(ev.payload);
    if (!text) return chats;
    const role = pickString(ev.payload, 'role') === 'user' ? 'user' : 'assistant';
    if (role === 'user' && hasRecentUserText(entries, text)) return chats;
    return { ...chats, [ev.projectId]: [...entries, newEntry(role, text, false, ev.ts)] };
  }

  if (ev.kind === 'goal.created') {
    const prompt = pickString(ev.payload, 'prompt');
    const next = entries.slice();
    if (prompt && !hasRecentUserText(entries, prompt)) {
      next.push(newEntry('user', prompt, false, ev.ts));
    }
    if (!next.some((e) => e.pending)) {
      next.push(newEntry('assistant', 'running…', true, ev.ts));
    }
    if (next.length === entries.length) return chats;
    return { ...chats, [ev.projectId]: next };
  }

  if (ev.kind === 'task.end' || ev.kind === 'llm.call') {
    const text = extractText(ev.payload);
    const idx = entries.findIndex((e) => e.pending);
    if (idx >= 0 && (text || ev.kind === 'task.end')) {
      const next = entries.slice();
      const cur = next[idx];
      if (cur) {
        next[idx] = { ...cur, text: text ?? '(task finished — no text in payload)', pending: false, ts: ev.ts };
      }
      return { ...chats, [ev.projectId]: next };
    }
    if (idx < 0 && ev.kind === 'task.end' && text) {
      return { ...chats, [ev.projectId]: [...entries, newEntry('assistant', text, false, ev.ts)] };
    }
    return chats;
  }

  return chats;
}

/* ---------- components ---------- */

const FEED_LIMIT = 500;

function FeedRow({ ev }: { ev: FeedEvent }) {
  const ns = ev.kind.split('.')[0] ?? 'event';
  const model = extractModel(ev.payload);
  const tool = extractTool(ev.payload, ev.kind);
  const cost = extractCost(ev.payload);
  return (
    <div className="feed-row">
      <span className={`badge ns-${ns}`}>{ev.kind}</span>
      <span className="ts">{fmtTime(ev.ts)}</span>
      {model && <span className="meta model">{model}</span>}
      {tool && <span className="meta tool">{tool}</span>}
      {cost !== undefined && <span className="meta cost">${cost.toFixed(4)}</span>}
      {ev.taskId && <span className="meta task">{ev.taskId.slice(0, 8)}</span>}
      <span className="meta project">{ev.projectId}</span>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [chats, setChats] = useState<ChatsState>({});
  const [input, setInput] = useState('');
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [error, setError] = useState<string | undefined>();
  const [rightTab, setRightTab] = useState<RightTab>('feed');
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // ---- Auth (Phase 4) ----
  // authMode is detected from /api/whoami. When 'on' and we have no token, a
  // login form gates the app. The token lives in memory (../api) and is sent on
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

  const transcript = chats[selectedId] ?? [];

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

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

  // Login gate: only shown when auth is ON and we are not authenticated.
  if (authMode === 'on' && !authed) {
    return (
      <div className="app">
        <header className="header">
          <h1>Lunaris · Mission Control</h1>
        </header>
        <div className="login-gate">
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void doLogin();
            }}
          >
            <h2>sign in</h2>
            <input
              type="text"
              value={loginUser}
              placeholder="user"
              autoComplete="username"
              onChange={(e) => setLoginUser(e.target.value)}
            />
            <input
              type="password"
              value={loginPassword}
              placeholder="password"
              autoComplete="current-password"
              onChange={(e) => setLoginPassword(e.target.value)}
            />
            {loginError && <div className="error">{loginError}</div>}
            <button type="submit" disabled={loginUser.trim().length === 0}>
              sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Lunaris · Mission Control</h1>
        <span className={`ws-dot ws-${wsStatus}`} title={`websocket: ${wsStatus}`} />
        <span className="ws-label">{wsStatus}</span>
        {principalName && (
          <span className="who" title={principalRole ? `role: ${principalRole}` : undefined}>
            {principalName}
            {principalRole ? ` · ${principalRole}` : ''}
          </span>
        )}
        {authMode === 'on' && authed && (
          <button type="button" className="logout" onClick={doLogout}>
            sign out
          </button>
        )}
      </header>

      <main className="main">
        <section className="left">
          <div className="picker">
            <label htmlFor="project-select">project</label>
            <select
              id="project-select"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {projects.length === 0 && <option value="">(no projects)</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void loadProjects()}>
              ↻
            </button>
          </div>
          {error && <div className="error">{error}</div>}

          <div className="transcript" ref={transcriptRef}>
            {transcript.length === 0 && (
              <div className="empty">no messages yet — send a goal below</div>
            )}
            {transcript.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}${m.pending ? ' msg-pending' : ''}`}>
                <span className="msg-role">{m.role}</span>
                <span className="msg-ts">{fmtTime(m.ts)}</span>
                <div className="msg-text">{m.text}</div>
              </div>
            ))}
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void sendGoal();
            }}
          >
            <input
              type="text"
              value={input}
              placeholder={selectedId ? 'describe a goal…' : 'select a project first'}
              onChange={(e) => setInput(e.target.value)}
              disabled={!selectedId}
            />
            <button type="submit" disabled={!selectedId || input.trim().length === 0}>
              send
            </button>
          </form>
        </section>

        <section className="right">
          <div className="tabs">
            {(
              ['feed', 'analytics', 'memory', 'approvals', 'optimize', 'plugins', 'automation', 'system'] as RightTab[]
            ).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`tab${rightTab === tab ? ' tab-active' : ''}`}
                onClick={() => setRightTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>
          {rightTab === 'feed' && (
            <div className="feed">
              {events.length === 0 && <div className="empty">waiting for events…</div>}
              {events.map((ev) => (
                <FeedRow key={ev.eventId} ev={ev} />
              ))}
            </div>
          )}
          {rightTab === 'analytics' && <AnalyticsPanel projectId={selectedId} />}
          {rightTab === 'memory' && <MemoryPanel projectId={selectedId} />}
          {rightTab === 'approvals' && <ApprovalsPanel projectId={selectedId} />}
          {rightTab === 'optimize' && <OptimizePanel projectId={selectedId} />}
          {rightTab === 'plugins' && <PluginsPanel projectId={selectedId} />}
          {rightTab === 'automation' && <AutomationPanel projectId={selectedId} />}
          {rightTab === 'system' && <SystemPanel projectId={selectedId} />}
        </section>
      </main>
    </div>
  );
}
