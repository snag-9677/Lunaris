/**
 * SqliteTriggerStore: CRUD over inbound trigger rules (webhooks/events), backed
 * by node:sqlite (DatabaseSync, WAL for file-backed stores).
 *
 * routeEvent(source, eventType, payload, enqueue) finds enabled rules matching
 * the (source, eventType) pair, renders each rule's promptTemplate against vars
 * derived from the payload, and enqueues a goal with source `webhook:<source>`.
 *
 * verifyHmac performs a TIMING-SAFE HMAC-SHA256 signature check using node:crypto
 * (crypto.timingSafeEqual), supporting bare hex digests and the GitHub-style
 * "sha256=<hex>" header form.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type { TriggerRule } from '@lunaris/core';
import { renderTemplate } from './templates.js';

interface TriggerRow {
  id: string;
  project_id: string;
  source: string;
  event_types: string;
  prompt_template: string;
  enabled: number;
}

function rowToRule(row: TriggerRow): TriggerRule {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    eventTypes: JSON.parse(row.event_types) as string[],
    promptTemplate: row.prompt_template,
    enabled: row.enabled !== 0,
  };
}

export interface CreateTriggerInput {
  projectId: string;
  source: string;
  eventTypes: string[];
  promptTemplate: string;
  enabled?: boolean;
}

/** Enqueue callback injected into routeEvent(): how a matched rule reaches the queue. */
export type EnqueueFn = (projectId: string, prompt: string, source: string) => void;

/**
 * Flatten a JSON-ish payload into string vars for {{placeholder}} rendering.
 * Nested objects/arrays are addressed with dotted keys (e.g. {{repo.name}},
 * {{commits.0.id}}). Primitive leaves become strings; null/undefined are skipped.
 * Also exposes {{eventType}} and {{source}} convenience vars (set by routeEvent).
 */
export function payloadToVars(payload: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(v, path === '' ? k : `${path}.${k}`);
      }
    } else {
      out[path] = String(value);
    }
  };
  visit(payload, prefix);
  return out;
}

export class SqliteTriggerStore {
  private readonly db: DatabaseSync;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_rules (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        source          TEXT NOT NULL,
        event_types     TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        enabled         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_source ON trigger_rules (source, enabled);
      CREATE INDEX IF NOT EXISTS idx_triggers_project ON trigger_rules (project_id, id);
    `);
  }

  create(input: CreateTriggerInput): TriggerRule {
    const rule: TriggerRule = {
      id: uuidv7(),
      projectId: input.projectId,
      source: input.source,
      eventTypes: input.eventTypes,
      promptTemplate: input.promptTemplate,
      enabled: input.enabled ?? true,
    };
    this.db
      .prepare(
        `INSERT INTO trigger_rules
           (id, project_id, source, event_types, prompt_template, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id,
        rule.projectId,
        rule.source,
        JSON.stringify(rule.eventTypes),
        rule.promptTemplate,
        rule.enabled ? 1 : 0,
      );
    return rule;
  }

  get(id: string): TriggerRule | undefined {
    const row = this.db
      .prepare(`SELECT * FROM trigger_rules WHERE id = ?`)
      .get(id) as unknown as TriggerRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  list(projectId?: string, source?: string): TriggerRule[] {
    const where: string[] = [];
    const params: string[] = [];
    if (projectId !== undefined) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (source !== undefined) {
      where.push('source = ?');
      params.push(source);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM trigger_rules ${whereSql} ORDER BY id ASC`)
      .all(...params) as unknown as TriggerRow[];
    return rows.map(rowToRule);
  }

  update(
    id: string,
    patch: Partial<Pick<TriggerRule, 'source' | 'eventTypes' | 'promptTemplate' | 'enabled'>>,
  ): TriggerRule | undefined {
    const existing = this.get(id);
    if (existing === undefined) return undefined;
    const next: TriggerRule = {
      id,
      projectId: existing.projectId,
      source: patch.source ?? existing.source,
      eventTypes: patch.eventTypes ?? existing.eventTypes,
      promptTemplate: patch.promptTemplate ?? existing.promptTemplate,
      enabled: patch.enabled ?? existing.enabled,
    };
    this.db
      .prepare(
        `UPDATE trigger_rules
            SET source = ?, event_types = ?, prompt_template = ?, enabled = ?
          WHERE id = ?`,
      )
      .run(
        next.source,
        JSON.stringify(next.eventTypes),
        next.promptTemplate,
        next.enabled ? 1 : 0,
        id,
      );
    return next;
  }

  /** Returns true if a row was deleted. */
  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM trigger_rules WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /**
   * Match enabled rules by (source, eventType), render each promptTemplate with
   * payload-derived vars (plus {{eventType}} and {{source}}), and enqueue a goal
   * per matched rule with source `webhook:<source>`. Returns the matched rules
   * (so callers can log/audit). No match => empty array, no enqueue.
   */
  routeEvent(
    source: string,
    eventType: string,
    payload: unknown,
    enqueue: EnqueueFn,
  ): TriggerRule[] {
    const candidates = this.db
      .prepare(`SELECT * FROM trigger_rules WHERE source = ? AND enabled = 1 ORDER BY id ASC`)
      .all(source) as unknown as TriggerRow[];

    const vars = { ...payloadToVars(payload), eventType, source };
    const matched: TriggerRule[] = [];
    for (const row of candidates) {
      const rule = rowToRule(row);
      if (!rule.eventTypes.includes(eventType)) continue;
      const prompt = renderTemplate(rule.promptTemplate, vars);
      enqueue(rule.projectId, prompt, `webhook:${source}`);
      matched.push(rule);
    }
    return matched;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Timing-safe HMAC-SHA256 signature verification.
 *
 * Computes HMAC-SHA256(secret, rawBody) and compares it to `signatureHeader`
 * using crypto.timingSafeEqual (constant-time, no early-out on first mismatch).
 * Accepts both a bare lowercase hex digest and the GitHub-style "sha256=<hex>"
 * prefix. Returns false (never throws) for malformed/length-mismatched headers.
 */
export function verifyHmac(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string,
): boolean {
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  const expected = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  // timingSafeEqual requires equal lengths; a length mismatch is itself a non-match.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
