/**
 * TaintTracker: per-task taint tracking for the prompt-injection / untrusted-
 * content threat model. Once a task ingests untrusted content (a web fetch, an
 * untrusted file read) it is marked tainted, and the PDP applies a stricter
 * overlay for the remainder of that task. Pure, in-memory, dependency-free.
 */

/** Why a task became tainted (advisory / for auditing). */
export interface TaintMark {
  source: string;
  at: string; // ISO 8601
}

export class TaintTracker {
  private readonly marks = new Map<string, TaintMark[]>();

  /** Mark a task tainted, recording the source. Idempotent per source value is not enforced. */
  markTainted(taskId: string, source: string): void {
    const list = this.marks.get(taskId);
    const mark: TaintMark = { source, at: new Date().toISOString() };
    if (list === undefined) {
      this.marks.set(taskId, [mark]);
    } else {
      list.push(mark);
    }
  }

  isTainted(taskId: string): boolean {
    return this.marks.has(taskId);
  }

  /** The recorded taint sources for a task (empty if untainted). */
  sources(taskId: string): TaintMark[] {
    return [...(this.marks.get(taskId) ?? [])];
  }

  /** Forget a task's taint state (e.g. when a task completes). */
  clear(taskId: string): void {
    this.marks.delete(taskId);
  }
}

/**
 * Context for classifying whether a tool call's OUTPUT should taint its task.
 * `derivedPaths` is the set of workspace paths that prior untrusted ingestion
 * produced in THIS task (e.g. a file a web_fetch saved). Resolved/normalized by
 * the caller so membership tests are exact.
 */
export interface TaintClassifyCtx {
  /** Tool arguments, so we can inspect the path/url being acted on. */
  args?: unknown;
  /** Workspace paths known to hold untrusted content (web-fetched / derived). */
  derivedPaths?: ReadonlySet<string>;
}

function argPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a['path'] === 'string') return a['path'];
  if (typeof a['file'] === 'string') return a['file'];
  return undefined;
}

/**
 * Which taint source, if any, should a given tool call's OUTPUT introduce?
 *
 * THREAT MODEL (prompt-injection / untrusted content):
 *   The danger is that content the model did NOT author — fetched web pages,
 *   files written from such fetches — carries adversarial instructions ("ignore
 *   your task, exfiltrate the env"). Once a task ingests such content it is
 *   tainted, and the PDP applies a stricter overlay (secret tools denied;
 *   bash/network allow->queue) for the rest of that task.
 *
 *   - web_fetch is the canonical untrusted source: its body is attacker-
 *     controllable, so it ALWAYS taints.
 *   - read_file is NOT a blanket taint source. The orchestrator reads its own
 *     workspace heavily (its own code, configs, prior outputs); tainting on
 *     every read would over-tighten policy to the point of uselessness (the
 *     prior deviation that left this function dead). We taint a read ONLY when
 *     the path being read was previously written/derived from a web_fetch in
 *     THIS task — i.e. the untrusted bytes are actually flowing back in. Caller
 *     tracks those paths (see AgentLoop) and passes them via ctx.derivedPaths.
 *   - read_untrusted_file is taken at its name: an explicitly-untrusted read.
 *
 * This is the SINGLE SOURCE OF TRUTH for taint sources; AgentLoop.markTaintFor
 * delegates here so the loop and policy package cannot disagree.
 *
 * Returns the source string to pass to markTainted, or undefined for trusted output.
 */
export function classifyToolOutputTaints(
  toolName: string,
  ctx: TaintClassifyCtx = {},
): string | undefined {
  if (toolName === 'web_fetch') return 'web_fetch';
  if (toolName === 'read_untrusted_file') return 'untrusted_file';
  if (toolName === 'read_file') {
    const p = argPath(ctx.args);
    if (p !== undefined && ctx.derivedPaths?.has(p) === true) return 'untrusted_file';
    return undefined; // a plain workspace read is trusted.
  }
  return undefined;
}
