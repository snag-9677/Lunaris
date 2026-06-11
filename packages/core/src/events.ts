/**
 * SqliteEventStore: append-only event spine backed by node:sqlite (DatabaseSync).
 * WAL mode for file-backed stores; in-process pub/sub on append.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from './ids.js';
import type { EventEnvelope, EventStore } from './types.js';

const DEFAULT_QUERY_LIMIT = 100;

interface EventRow {
  event_id: string;
  ts: string;
  project_id: string;
  kind: string;
  task_id: string | null;
  agent_id: string | null;
  payload: string;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  const e: EventEnvelope = {
    eventId: row.event_id,
    ts: row.ts,
    projectId: row.project_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
  };
  if (row.task_id !== null) e.taskId = row.task_id;
  if (row.agent_id !== null) e.agentId = row.agent_id;
  return e;
}

export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;
  private readonly subscribers = new Set<(e: EventEnvelope) => void>();

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id   TEXT PRIMARY KEY,
        ts         TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind       TEXT NOT NULL,
        task_id    TEXT,
        agent_id   TEXT,
        payload    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind, event_id);
    `);
  }

  append(e: Omit<EventEnvelope, 'eventId' | 'ts'>): EventEnvelope {
    const envelope: EventEnvelope = {
      ...e,
      eventId: uuidv7(),
      ts: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO events (event_id, ts, project_id, kind, task_id, agent_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.eventId,
        envelope.ts,
        envelope.projectId,
        envelope.kind,
        envelope.taskId ?? null,
        envelope.agentId ?? null,
        JSON.stringify(envelope.payload ?? null),
      );

    // Snapshot so subscribers may unsubscribe during dispatch.
    for (const fn of [...this.subscribers]) {
      try {
        fn(envelope);
      } catch {
        // A throwing subscriber must not break append or other subscribers.
      }
    }
    return envelope;
  }

  query(opts: { projectId?: string; kind?: string; limit?: number }): EventEnvelope[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(opts.projectId);
    }
    if (opts.kind !== undefined) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_QUERY_LIMIT));
    // event_id is UUIDv7 (time-ordered), so ordering by it yields newest first.
    const rows = this.db
      .prepare(
        `SELECT event_id, ts, project_id, kind, task_id, agent_id, payload
         FROM events ${whereSql}
         ORDER BY event_id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as EventRow[];
    return rows.map(rowToEnvelope);
  }

  subscribe(fn: (e: EventEnvelope) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  close(): void {
    this.subscribers.clear();
    this.db.close();
  }
}
