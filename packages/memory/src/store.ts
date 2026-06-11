/**
 * SqliteMemoryStore: per-project graphified, guide-not-oracle memory backed by
 * node:sqlite (DatabaseSync). WAL mode for file-backed stores.
 *
 * Design stance (guide, not oracle): memory is ADVISORY. The retention gate is
 * selective so the store stays small and high-signal; briefs are clearly marked
 * as fallible and possibly stale; tainted records are flagged untrusted.
 *
 * Offline-first: similarity uses a deterministic local lexical metric by
 * default (no network, no LLM). An optional async `embed` may be supplied; its
 * vectors are cached and used opportunistically (see `warm`), but the sync
 * MemoryStore methods always have a working synchronous path.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type {
  MemoryBrief,
  MemoryEntity,
  MemoryProposal,
  MemoryRecord,
  MemoryRelation,
  MemoryStore,
  MemoryType,
  RetentionDecision,
} from '@lunaris/core';
import { detectCommunities, type CoEdge } from './clustering.js';
import { lexicalSimilarity, tokenize, vectorCosine } from './similarity.js';

export type EmbedFn = (text: string) => Promise<number[]>;

export interface SqliteMemoryStoreOptions {
  /** sqlite file path (parent dirs created) or ':memory:'. */
  dbPath: string;
  projectId: string;
  /** Optional async embedding fn; absent => deterministic lexical similarity. */
  embed?: EmbedFn;
  /** Acceptance threshold for the weighted retention score (default 0.45). */
  retentionThreshold?: number;
  /** Minimum novelty to insert; below this a near-duplicate is reinforced. */
  noveltyFloor?: number;
  /** Minimum (utility + generality) sum; guards against pure-novelty junk (default 0.3). */
  qualityFloor?: number;
  /** Half-life in days for strength decay during prune (default 30). */
  halfLifeDays?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

interface RecordRow {
  id: string;
  project_id: string;
  type: string;
  statement: string;
  entities: string;
  confidence: number;
  strength: number;
  created_at: string;
  last_used_at: string | null;
  source_goal_id: string | null;
  tainted: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_THRESHOLD = 0.45;
const DEFAULT_NOVELTY_FLOOR = 0.15;
const DEFAULT_QUALITY_FLOOR = 0.3;
const DEFAULT_HALF_LIFE_DAYS = 30;
const DUPLICATE_SIMILARITY = 0.85; // >= this to an existing record => duplicate

function rowToRecord(row: RecordRow): MemoryRecord {
  const rec: MemoryRecord = {
    id: row.id,
    projectId: row.project_id,
    type: row.type as MemoryType,
    statement: row.statement,
    entities: JSON.parse(row.entities) as string[],
    confidence: row.confidence,
    strength: row.strength,
    createdAt: row.created_at,
    tainted: row.tainted !== 0,
  };
  if (row.last_used_at !== null) rec.lastUsedAt = row.last_used_at;
  if (row.source_goal_id !== null) rec.sourceGoalId = row.source_goal_id;
  return rec;
}

/** Extract candidate entities: provided ones plus capitalized words / code identifiers. */
export function extractEntities(statement: string, provided: string[]): string[] {
  const found = new Set<string>(provided.map((e) => e.trim()).filter((e) => e.length > 0));
  // Proper nouns: Capitalized tokens not at obvious sentence-start-only positions.
  for (const m of statement.match(/\b[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)*\b/g) ?? []) {
    found.add(m);
  }
  // Code identifiers: camelCase, snake_case, dotted.paths, foo() calls.
  for (const m of statement.match(/\b[a-zA-Z_][a-zA-Z0-9_]*(?:[._][a-zA-Z0-9_]+)+\b/g) ?? []) {
    found.add(m);
  }
  for (const m of statement.match(/\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/g) ?? []) {
    found.add(m);
  }
  return [...found];
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly projectId: string;
  private readonly embedFn?: EmbedFn;
  private readonly threshold: number;
  private readonly noveltyFloor: number;
  private readonly qualityFloor: number;
  private readonly halfLifeDays: number;
  private readonly clock: () => Date;
  /** Cache of text -> embedding vector, populated via warm(). */
  private readonly embedCache = new Map<string, number[]>();

  constructor(opts: SqliteMemoryStoreOptions) {
    this.projectId = opts.projectId;
    this.embedFn = opts.embed;
    this.threshold = opts.retentionThreshold ?? DEFAULT_THRESHOLD;
    this.noveltyFloor = opts.noveltyFloor ?? DEFAULT_NOVELTY_FLOOR;
    this.qualityFloor = opts.qualityFloor ?? DEFAULT_QUALITY_FLOOR;
    this.halfLifeDays = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    this.clock = opts.now ?? (() => new Date());

    if (opts.dbPath !== ':memory:') {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL,
        type           TEXT NOT NULL,
        statement      TEXT NOT NULL,
        entities       TEXT NOT NULL,
        confidence     REAL NOT NULL,
        strength       REAL NOT NULL,
        created_at     TEXT NOT NULL,
        last_used_at   TEXT,
        source_goal_id TEXT,
        tainted        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mem_project ON memory_records (project_id);
      CREATE TABLE IF NOT EXISTS relations (
        from_entity TEXT NOT NULL,
        to_entity   TEXT NOT NULL,
        rel         TEXT NOT NULL,
        record_id   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rel_record ON relations (record_id);
      CREATE TABLE IF NOT EXISTS entities (
        name         TEXT PRIMARY KEY,
        kind         TEXT,
        community_id INTEGER
      );
    `);
  }

  // ---------- similarity ----------

  /** Synchronous similarity in 0..1; uses cached embeddings when both present, else lexical. */
  private similarity(a: string, b: string): number {
    if (this.embedFn) {
      const va = this.embedCache.get(a);
      const vb = this.embedCache.get(b);
      if (va && vb) return vectorCosine(va, vb);
    }
    return lexicalSimilarity(a, b);
  }

  /**
   * Pre-compute and cache embeddings for the given texts (no-op without an embed
   * fn). Call this before search/brief/propose to enable the embedding path; the
   * sync methods otherwise fall back to lexical similarity.
   */
  async warm(texts: string[]): Promise<void> {
    if (!this.embedFn) return;
    for (const t of texts) {
      if (!this.embedCache.has(t)) {
        this.embedCache.set(t, await this.embedFn(t));
      }
    }
  }

  private allRecords(): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, type, statement, entities, confidence, strength,
                created_at, last_used_at, source_goal_id, tainted
         FROM memory_records WHERE project_id = ?`,
      )
      .all(this.projectId) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  // ---------- retention scoring ----------

  /** Utility heuristic 0..1: longer / proper-noun / procedural statements score higher. */
  private utilityScore(p: MemoryProposal): number {
    const s = p.statement.trim();
    const tokens = tokenize(s);
    let score = 0;
    // Length: meaningful but capped (very short statements rarely carry reusable value).
    score += Math.min(0.35, tokens.length / 30);
    // Proper-noun / code identifier bearing => concrete, referenceable.
    if (/[A-Z][a-zA-Z0-9]+/.test(s) || /[a-zA-Z_][a-zA-Z0-9_]*[._][a-zA-Z0-9_]+/.test(s)) {
      score += 0.2;
    }
    // Procedural cues (how-to / steps / commands) are highly reusable.
    if (p.type === 'procedural' || /\b(run|use|prefer|always|never|first|then|avoid|set|configure|install)\b/i.test(s)) {
      score += 0.25;
    }
    // Episodic failures are noted as useful (don't-repeat-this signal).
    if (p.type === 'episodic' && /\b(fail|failed|error|broke|crash|regress|timeout|denied)\b/i.test(s)) {
      score += 0.2;
    }
    // Semantic facts about the project are baseline-useful.
    if (p.type === 'semantic') score += 0.1;
    return Math.min(1, score);
  }

  /** Generality 0..1: reward reusable statements, penalize one-off specifics. */
  private generalityScore(p: MemoryProposal): number {
    const s = p.statement;
    let score = 0.5;
    // One-off specifics: timestamps, long digit runs, uuids, absolute temp paths.
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(s) || /\b\d{6,}\b/.test(s)) score -= 0.25;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(s)) score -= 0.2;
    if (/\/tmp\/|\/var\/folders\//.test(s)) score -= 0.15;
    // Reusable phrasing => generalizable advice.
    if (/\b(always|never|generally|usually|prefer|pattern|convention|all|any|whenever)\b/i.test(s)) {
      score += 0.25;
    }
    // Naming a stable subject (proper noun) modestly raises reusability.
    if (/\b[A-Z][a-zA-Z0-9]+\b/.test(s)) score += 0.1;
    return Math.max(0, Math.min(1, score));
  }

  // ---------- MemoryStore ----------

  propose(p: MemoryProposal): RetentionDecision {
    const statement = p.statement.trim();
    // FIX 6: reject empty / no-token statements up front. A statement with no
    // meaningful tokens (empty, whitespace, or only stopwords/punctuation) is
    // junk: it carries zero retrievable signal yet can score through the gate on
    // pure novelty. Gate it before any scoring runs.
    if (tokenize(statement).length === 0) {
      return {
        accepted: false,
        scores: { novelty: 0, utility: 0, generality: 0 },
        reason: 'empty-statement',
      };
    }
    // Novelty is scored against ALL existing project records (dedupe is type-agnostic).
    const existing = this.allRecords();
    let maxSim = 0;
    let nearest: MemoryRecord | undefined;
    for (const r of existing) {
      const sim = this.similarity(statement, r.statement);
      if (sim > maxSim) {
        maxSim = sim;
        nearest = r;
      }
    }
    const novelty = 1 - maxSim;
    const utility = this.utilityScore(p);
    const generality = this.generalityScore(p);
    const scores = { novelty, utility, generality };

    // Near-duplicate => reinforce the existing record instead of inserting.
    if (nearest && maxSim >= DUPLICATE_SIMILARITY) {
      this.reinforce(nearest.id, true);
      return {
        accepted: false,
        scores,
        reason: 'duplicate-reinforced',
        recordId: nearest.id,
      };
    }

    const weighted = 0.4 * novelty + 0.35 * utility + 0.25 * generality;
    if (novelty < this.noveltyFloor) {
      return { accepted: false, scores, reason: `low-novelty (${novelty.toFixed(2)} < ${this.noveltyFloor})` };
    }
    // Quality floor: pure novelty must not carry low-signal junk. A statement
    // with negligible utility AND generality is rejected even when novel, so an
    // empty/sparse store still stays selective.
    if (utility + generality < this.qualityFloor) {
      return { accepted: false, scores, reason: `low-quality (util+gen ${(utility + generality).toFixed(2)} < ${this.qualityFloor})` };
    }
    if (weighted < this.threshold) {
      return { accepted: false, scores, reason: `below-threshold (${weighted.toFixed(2)} < ${this.threshold})` };
    }

    const id = uuidv7();
    const now = this.clock().toISOString();
    const entityList = extractEntities(statement, p.entities);
    this.db
      .prepare(
        `INSERT INTO memory_records
           (id, project_id, type, statement, entities, confidence, strength,
            created_at, last_used_at, source_goal_id, tainted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.projectId,
        p.type,
        statement,
        JSON.stringify(entityList),
        weighted,
        1.0,
        now,
        null,
        p.sourceGoalId ?? null,
        p.tainted ? 1 : 0,
      );

    this.upsertEntities(entityList);
    this.deriveRelations(id, entityList);

    return { accepted: true, scores, reason: `accepted (${weighted.toFixed(2)})`, recordId: id };
  }

  private upsertEntities(names: string[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO entities (name, kind, community_id) VALUES (?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    );
    for (const name of names) {
      const kind = /^[A-Z]/.test(name)
        ? 'proper-noun'
        : /[._]/.test(name)
          ? 'identifier'
          : 'term';
      stmt.run(name, kind, null);
    }
  }

  /** Derive undirected co-occurrence relations between every entity pair in a record. */
  private deriveRelations(recordId: string, names: string[]): void {
    const uniq = [...new Set(names)].sort();
    const stmt = this.db.prepare(
      `INSERT INTO relations (from_entity, to_entity, rel, record_id) VALUES (?, ?, ?, ?)`,
    );
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        stmt.run(uniq[i] as string, uniq[j] as string, 'co-occurs', recordId);
      }
    }
  }

  search(query: string, limit = 8): MemoryRecord[] {
    const records = this.allRecords();
    const cap = Math.max(0, limit);

    // FIX 3: an empty/whitespace query (tokenize length 0) has no terms to score
    // against, so the similarity path would return []. Treat it as "browse the
    // strongest records": order by strength DESC, then createdAt DESC (newest
    // first as a tiebreak), limited. This is what the daemon
    // `/api/projects/:id/memory` and the CLI `lun memory` (no query) rely on.
    if (tokenize(query).length === 0) {
      return [...records]
        .sort((a, b) => b.strength - a.strength || b.createdAt.localeCompare(a.createdAt))
        .slice(0, cap);
    }

    const scored = records.map((r) => ({ r, score: this.similarity(query, r.statement) * r.strength }));
    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0)
      .slice(0, cap)
      .map((s) => s.r);
  }

  brief(taskPrompt: string, budgetChars = 1500): MemoryBrief {
    const header = 'Advisory memory — verify before relying; may be stale/wrong:';
    const hits = this.search(taskPrompt, 32);
    const recordIds: string[] = [];
    const now = this.clock().getTime();

    // Group by type for readability.
    const groups: Record<MemoryType, MemoryRecord[]> = {
      semantic: [],
      procedural: [],
      episodic: [],
    };
    for (const r of hits) groups[r.type].push(r);

    const lines: string[] = [header];
    let used = header.length;
    const order: MemoryType[] = ['semantic', 'procedural', 'episodic'];
    const labels: Record<MemoryType, string> = {
      semantic: 'Facts',
      procedural: 'How-to',
      episodic: 'Past episodes',
    };

    outer: for (const type of order) {
      const recs = groups[type];
      if (recs.length === 0) continue;
      const heading = `${labels[type]}:`;
      // Tentatively add the group heading; only commit if at least one line fits.
      let headingAdded = false;
      for (const r of recs) {
        const ageDays = Math.max(0, Math.floor((now - new Date(r.createdAt).getTime()) / DAY_MS));
        const taint = r.tainted ? ' (untrusted-source)' : '';
        const line = `- [conf ${r.confidence.toFixed(2)}, age ${ageDays}d]${taint} ${r.statement}`;
        const headingCost = headingAdded ? 0 : heading.length + 1;
        if (used + 1 + headingCost + line.length > budgetChars) break outer;
        if (!headingAdded) {
          lines.push(heading);
          used += heading.length + 1;
          headingAdded = true;
        }
        lines.push(line);
        used += line.length + 1;
        recordIds.push(r.id);
      }
    }

    return { text: lines.join('\n'), recordIds };
  }

  reinforce(recordId: string, helpful: boolean): void {
    const row = this.db
      .prepare(`SELECT strength FROM memory_records WHERE id = ? AND project_id = ?`)
      .get(recordId, this.projectId) as { strength: number } | undefined;
    if (!row) return;
    const next = helpful
      ? Math.min(1, row.strength * 1.15 + 0.1)
      : row.strength * 0.7;
    const now = this.clock().toISOString();
    if (helpful) {
      this.db
        .prepare(`UPDATE memory_records SET strength = ?, last_used_at = ? WHERE id = ?`)
        .run(next, now, recordId);
    } else {
      this.db.prepare(`UPDATE memory_records SET strength = ? WHERE id = ?`).run(next, recordId);
    }
  }

  entities(): MemoryEntity[] {
    this.recluster();
    const rows = this.db
      .prepare(`SELECT name, kind, community_id FROM entities ORDER BY name`)
      .all() as unknown as { name: string; kind: string | null; community_id: number | null }[];
    return rows.map((r) => {
      const e: MemoryEntity = { name: r.name };
      if (r.kind !== null) e.kind = r.kind;
      if (r.community_id !== null) e.communityId = r.community_id;
      return e;
    });
  }

  relations(): MemoryRelation[] {
    const rows = this.db
      .prepare(`SELECT from_entity, to_entity, rel, record_id FROM relations`)
      .all() as unknown as { from_entity: string; to_entity: string; rel: string; record_id: string }[];
    return rows.map((r) => ({
      from: r.from_entity,
      to: r.to_entity,
      rel: r.rel,
      recordId: r.record_id,
    }));
  }

  /** Run label-propagation clustering over the co-occurrence graph; persist community_id. */
  recluster(): void {
    const nodeRows = this.db.prepare(`SELECT name FROM entities`).all() as unknown as { name: string }[];
    const nodes = nodeRows.map((r) => r.name);
    if (nodes.length === 0) return;

    const relRows = this.db
      .prepare(`SELECT from_entity, to_entity FROM relations`)
      .all() as unknown as { from_entity: string; to_entity: string }[];
    // Collapse parallel edges into weights.
    const weights = new Map<string, CoEdge>();
    for (const r of relRows) {
      const key = r.from_entity < r.to_entity
        ? `${r.from_entity} ${r.to_entity}`
        : `${r.to_entity} ${r.from_entity}`;
      const existing = weights.get(key);
      if (existing) existing.weight += 1;
      else weights.set(key, { a: r.from_entity, b: r.to_entity, weight: 1 });
    }

    const communities = detectCommunities(nodes, [...weights.values()]);
    const stmt = this.db.prepare(`UPDATE entities SET community_id = ? WHERE name = ?`);
    for (const [name, cid] of communities) stmt.run(cid, name);
  }

  /**
   * Apply exponential decay to every record's strength using the configured
   * half-life (against last_used_at when present, else created_at) and delete
   * records whose decayed strength falls below 0.05. Returns pruned count.
   * @param nowParam optional clock override for deterministic tests.
   */
  prune(nowParam?: Date): number {
    const now = (nowParam ?? this.clock()).getTime();
    const halfLifeMs = this.halfLifeDays * DAY_MS;
    const rows = this.db
      .prepare(`SELECT id, strength, created_at, last_used_at FROM memory_records WHERE project_id = ?`)
      .all(this.projectId) as unknown as {
      id: string;
      strength: number;
      created_at: string;
      last_used_at: string | null;
    }[];

    const update = this.db.prepare(`UPDATE memory_records SET strength = ? WHERE id = ?`);
    const del = this.db.prepare(`DELETE FROM memory_records WHERE id = ?`);
    const delRel = this.db.prepare(`DELETE FROM relations WHERE record_id = ?`);
    let pruned = 0;

    for (const r of rows) {
      const ref = new Date(r.last_used_at ?? r.created_at).getTime();
      const elapsed = Math.max(0, now - ref);
      const decayed = r.strength * Math.pow(0.5, elapsed / halfLifeMs);
      if (decayed < 0.05) {
        del.run(r.id);
        delRel.run(r.id);
        pruned++;
      } else {
        update.run(decayed, r.id);
      }
    }
    // Drop entities that no longer appear in any relation or record.
    this.gcEntities();
    return pruned;
  }

  /** Remove entities orphaned after pruning (not referenced by any surviving record). */
  private gcEntities(): void {
    const recs = this.allRecords();
    const live = new Set<string>();
    for (const r of recs) for (const e of r.entities) live.add(e);
    const all = this.db.prepare(`SELECT name FROM entities`).all() as unknown as { name: string }[];
    const delEnt = this.db.prepare(`DELETE FROM entities WHERE name = ?`);
    for (const { name } of all) {
      if (!live.has(name)) delEnt.run(name);
    }
  }

  close(): void {
    this.db.close();
  }
}
