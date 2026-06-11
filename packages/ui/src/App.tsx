import { useCallback, useEffect, useRef, useState } from 'react';

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
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
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
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry: number | undefined;

    const connect = () => {
      if (disposed) return;
      setWsStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
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
        if (!disposed) retry = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      disposed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

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
      const res = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/goals`, {
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

  return (
    <div className="app">
      <header className="header">
        <h1>Lunaris · Mission Control</h1>
        <span className={`ws-dot ws-${wsStatus}`} title={`websocket: ${wsStatus}`} />
        <span className="ws-label">{wsStatus}</span>
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
          <div className="feed-head">event feed</div>
          <div className="feed">
            {events.length === 0 && <div className="empty">waiting for events…</div>}
            {events.map((ev) => (
              <FeedRow key={ev.eventId} ev={ev} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
