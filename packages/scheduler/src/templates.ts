/**
 * SqliteTemplateStore: CRUD over reusable goal prompt templates, backed by
 * node:sqlite (DatabaseSync, WAL for file-backed stores).
 *
 * renderTemplate fills {{var}} placeholders from a vars map. Whitespace inside
 * the braces is tolerated ({{ var }}). UNKNOWN-VAR HANDLING: a placeholder whose
 * key is absent from `vars` is left intact (the literal "{{key}}" is preserved)
 * rather than replaced with an empty string — this surfaces missing-variable
 * mistakes instead of silently producing a malformed prompt.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@lunaris/core';
import type { GoalTemplate } from '@lunaris/core';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Replace {{var}} placeholders in `promptTemplate` with values from `vars`.
 * Unknown placeholders are left untouched (see module doc).
 */
export function renderTemplate(promptTemplate: string, vars: Record<string, string>): string {
  return promptTemplate.replace(PLACEHOLDER, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : whole,
  );
}

interface TemplateRow {
  id: string;
  name: string;
  prompt_template: string;
}

function rowToTemplate(row: TemplateRow): GoalTemplate {
  return { id: row.id, name: row.name, promptTemplate: row.prompt_template };
}

export interface CreateTemplateInput {
  name: string;
  promptTemplate: string;
}

export class SqliteTemplateStore {
  private readonly db: DatabaseSync;

  /** @param dbPath sqlite file path (parent dirs created) or ':memory:'. */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goal_templates (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        prompt_template TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_templates_name ON goal_templates (name);
    `);
  }

  create(input: CreateTemplateInput): GoalTemplate {
    const tpl: GoalTemplate = {
      id: uuidv7(),
      name: input.name,
      promptTemplate: input.promptTemplate,
    };
    this.db
      .prepare(`INSERT INTO goal_templates (id, name, prompt_template) VALUES (?, ?, ?)`)
      .run(tpl.id, tpl.name, tpl.promptTemplate);
    return tpl;
  }

  get(id: string): GoalTemplate | undefined {
    const row = this.db
      .prepare(`SELECT * FROM goal_templates WHERE id = ?`)
      .get(id) as unknown as TemplateRow | undefined;
    return row ? rowToTemplate(row) : undefined;
  }

  list(): GoalTemplate[] {
    const rows = this.db
      .prepare(`SELECT * FROM goal_templates ORDER BY id ASC`)
      .all() as unknown as TemplateRow[];
    return rows.map(rowToTemplate);
  }

  /** Patch name and/or promptTemplate. Returns the updated template, or undefined if unknown. */
  update(
    id: string,
    patch: Partial<Pick<GoalTemplate, 'name' | 'promptTemplate'>>,
  ): GoalTemplate | undefined {
    const existing = this.get(id);
    if (existing === undefined) return undefined;
    const next: GoalTemplate = {
      id,
      name: patch.name ?? existing.name,
      promptTemplate: patch.promptTemplate ?? existing.promptTemplate,
    };
    this.db
      .prepare(`UPDATE goal_templates SET name = ?, prompt_template = ? WHERE id = ?`)
      .run(next.name, next.promptTemplate, id);
    return next;
  }

  /** Returns true if a row was deleted. */
  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM goal_templates WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
