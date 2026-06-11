/**
 * Pure helpers for the live event feed and chat-transcript assembly. These were
 * lifted verbatim out of App.tsx so the component file can focus on rendering;
 * the WS transcript-assembly contract is unchanged. Dependency-free.
 */
import type { ChatEntry, ChatsState, FeedEvent, Project } from './types';

/* ---------- payload extraction helpers ---------- */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function pickString(obj: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function pickNumber(obj: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(obj)) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function extractModel(payload: unknown): string | undefined {
  return (
    pickString(payload, 'model') ??
    pickString(isRecord(payload) ? payload['request'] : undefined, 'model')
  );
}

export function extractTool(payload: unknown, kind: string): string | undefined {
  if (!kind.startsWith('tool')) return pickString(payload, 'tool');
  return pickString(payload, 'tool', 'name');
}

export function extractCost(payload: unknown): number | undefined {
  return (
    pickNumber(payload, 'costUsd', 'cost') ??
    pickNumber(isRecord(payload) ? payload['usage'] : undefined, 'costUsd')
  );
}

export function extractText(payload: unknown): string | undefined {
  return pickString(payload, 'text', 'summary', 'content', 'response', 'output', 'message');
}

export function toFeedEvent(v: unknown): FeedEvent | null {
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

export function normalizeProjects(data: unknown): Project[] {
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

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function newEntry(role: ChatEntry['role'], text: string, pending: boolean, ts: string): ChatEntry {
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
export function applyEventToChats(chats: ChatsState, ev: FeedEvent): ChatsState {
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

/* ---------- formatting helpers shared by panels ---------- */

export function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}kB`;
  return `${n}B`;
}

/** Tailwind text-color class per event-kind namespace, used by feed/badges. */
export function nsColorClass(ns: string): string {
  switch (ns) {
    case 'llm':
      return 'text-info';
    case 'tool':
      return 'text-warning';
    case 'task':
      return 'text-success';
    case 'goal':
      return 'text-[oklch(0.78_0.12_300)]';
    case 'chat':
      return 'text-primary';
    default:
      return 'text-muted-foreground';
  }
}
