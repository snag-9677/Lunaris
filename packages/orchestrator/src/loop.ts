/**
 * AgentLoop: the Phase 1 minimal agent loop.
 * Single orchestrator + one-level subagent spawn (spawn_subagent), iteration
 * budget guard, tool execution confined to the project root, JSONL journal of
 * every LLM turn and tool call under <projectRoot>/.lunaris/journal/.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalTicket,
  ChatMessage,
  ContentPart,
  EventStore,
  Goal,
  GoalStatus,
  MemoryProposal,
  MemoryStore,
  PluginHost,
  PolicyDecision,
  PolicyEngine,
  ResolvedTool,
  ResultEnvelope,
  RoleDef,
  StopReason,
  ToolCallCtx,
  ToolCallPart,
  ToolDef,
  ToolResultPart,
  UnifiedEvent,
  UnifiedRequest,
  Usage,
} from '@lunaris/core';
import { classifyToolOutputTaints } from '@lunaris/policy';
import { builtinRoles } from './roles.js';
import { builtinTools, requireStringArg, ToolError } from './tools.js';

/**
 * Minimal structural taint tracker the loop needs. @lunaris/policy's TaintTracker
 * satisfies this; we keep it structural so the orchestrator does not take a hard
 * dependency on the concrete class and Phase 1 callers stay unaffected.
 */
export interface TaintSink {
  markTainted(taskId: string, source: string): void;
  isTainted(taskId: string): boolean;
}

/**
 * Minimal structural approval sink. @lunaris/policy's SqliteApprovalQueue
 * satisfies this. Only create() is needed by the loop — resolution happens
 * out-of-band (human/CLI/daemon).
 */
export interface ApprovalSink {
  create(input: {
    projectId: string;
    tool: string;
    args: unknown;
    reason: string;
    planEpoch?: number;
  }): ApprovalTicket;
}

/**
 * Anything that can serve chat completions. The gateway package's router and
 * any ProviderAdapter both satisfy this structurally.
 */
export interface ChatGateway {
  chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent>;
}

export interface AgentLoopOptions {
  gateway: ChatGateway;
  events: EventStore;
  projectId: string;
  projectRoot: string;
  /** Default "<provider>/<model>"; a RoleDef.model overrides it. */
  model: string;
  /** Role registry override; defaults to the built-in roles. */
  roles?: Record<string, RoleDef>;
  /**
   * Phase 2 collaborators — all OPTIONAL. When absent the loop behaves exactly
   * as Phase 1 (no brief injection, no policy enforcement, no taint, no write-back).
   */
  /** Per-project graph memory. Injects a brief at run start; curates a write-back at the end. */
  memory?: MemoryStore;
  /** Policy Decision Point. Gates every tool call before execution. */
  policy?: PolicyEngine;
  /** Per-task taint tracker. Untrusted tool output (web_fetch / file reads) marks the task. */
  taint?: TaintSink;
  /** Sink for tool calls the policy routes to 'queue'. Without it, queue is treated as deny. */
  approvals?: ApprovalSink;
  /** Plan epoch stamped on approval tickets for the staleness guard. */
  planEpoch?: number;
  /**
   * Phase 3 — PLUGIN TOOLS (all OPTIONAL; Phase 1/2 callers are unaffected).
   * Pre-resolved plugin tools to merge into the registry. Names are already
   * namespaced `<pluginId>/<tool>` by the host. A role must still list the
   * namespaced name in its `tools` allowlist for the tool to be offered/run.
   */
  extraTools?: ResolvedTool[];
  /**
   * A PluginHost whose enabledTools() are resolved ONCE at run start and merged
   * alongside `extraTools`. If both are given, `extraTools` wins on a name clash.
   * A host that throws while resolving is treated as contributing no tools — the
   * run proceeds with built-ins only (plugins are additive, never load-bearing).
   */
  pluginHost?: PluginHost;
}

export interface AgentRunOutcome {
  goal: Goal;
  finalText: string;
  result: ResultEnvelope;
}

const DEFAULT_MAX_ITERATIONS = 16;
/** Phase 1: only the top-level agent (depth 0) may spawn subagents. */
const MAX_SPAWN_DEPTH = 1;

const SPAWN_SUBAGENT_DEF: ToolDef = {
  name: 'spawn_subagent',
  description:
    'Spawn a one-shot subagent to carry out a self-contained task and return its final report. ' +
    'The subagent shares no conversation context with you: the task brief must contain everything it needs.',
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string', description: "Subagent role name, e.g. 'coder'." },
      task: {
        type: 'string',
        description:
          'Fully self-contained task brief: goal, relevant file paths, constraints, acceptance criteria.',
      },
    },
    required: ['role', 'task'],
    additionalProperties: false,
  },
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated]`;
}

function summarizeArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args) ?? 'undefined', 200);
  } catch {
    return '[unserializable args]';
  }
}

function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

interface TurnResult {
  text: string;
  toolCalls: ToolCallPart[];
  stopReason: StopReason;
  usage?: Usage;
  error?: string;
}

export class AgentLoop {
  /**
   * Per-task set of workspace paths that hold untrusted (web-derived) content:
   * a write_file performed while the task is already tainted writes bytes that
   * trace back to a web_fetch, so a later read_file of that path re-taints.
   * See markTaintFor / classifyToolOutputTaints (the single source of truth).
   */
  private readonly derivedPaths = new Map<string, Set<string>>();

  /**
   * Plugin tools (namespaced <pluginId>/<tool>) resolved once at the start of a
   * run() and shared by the whole goal tree (orchestrator + subagents). Built-in
   * tools always take precedence on a name clash. Empty until resolvePluginTools
   * has run; resolution is idempotent per run().
   */
  private pluginTools = new Map<string, ResolvedTool>();

  constructor(private readonly opts: AgentLoopOptions) {}

  async run(goal: Goal, role = 'orchestrator'): Promise<AgentRunOutcome> {
    // PLUGIN TOOLS: resolve enabled plugin tools (host + extraTools) once for the
    // whole run. Built-ins win on any name clash; resolution never throws.
    await this.resolvePluginTools();
    // MEMORY GUIDE: prepend an advisory memory brief (guide, not oracle) to the
    // top-level prompt before the loop runs. The guide-not-oracle header comes
    // from brief() itself; we just frame it as an advisory block.
    const goalForRun = this.injectMemoryBrief(goal);
    const outcome = await this.runInternal(goalForRun, role, 0, goal.goalId);
    // MEMORY WRITE-BACK: curate 1-3 proposals from the outcome (post-run only —
    // subagents never write memory). Emits a memory.proposed event per decision.
    this.curateMemory(goal, outcome);
    return outcome;
  }

  // ----- internals -----

  /**
   * Returns a goal whose prompt is preceded by an advisory memory brief when a
   * memory store is injected; otherwise the goal is returned unchanged. The
   * original goalId is preserved so journaling and events line up.
   */
  private injectMemoryBrief(goal: Goal): Goal {
    const memory = this.opts.memory;
    if (memory === undefined) return goal;
    let brief: { text: string; recordIds: string[] };
    try {
      brief = memory.brief(goal.prompt);
    } catch {
      return goal; // memory is advisory; never let it break the run
    }
    if (brief.text.trim().length === 0 || brief.recordIds.length === 0) return goal;
    const block = [
      '<memory-brief advisory="true">',
      brief.text,
      '</memory-brief>',
      '',
      goal.prompt,
    ].join('\n');
    return { ...goal, prompt: block };
  }

  /**
   * Post-run curation: derive episodic proposals from the outcome and propose
   * them to memory. Tainted tasks tag their derived memory as untrusted. Each
   * proposal emits a memory.proposed event recording the retention decision.
   */
  private curateMemory(goal: Goal, outcome: AgentRunOutcome): void {
    const memory = this.opts.memory;
    if (memory === undefined) return;
    const tainted = this.opts.taint?.isTainted(goal.goalId) === true;
    const proposals = this.deriveProposals(goal, outcome, tainted);
    for (const proposal of proposals) {
      let decision;
      try {
        decision = memory.propose(proposal);
      } catch (e) {
        decision = {
          accepted: false,
          scores: { novelty: 0, utility: 0, generality: 0 },
          reason: `propose-error: ${errorMessage(e)}`,
        };
      }
      this.opts.events.append({
        projectId: this.opts.projectId,
        kind: 'memory.proposed',
        taskId: goal.goalId,
        agentId: 'orchestrator',
        payload: {
          type: proposal.type,
          statement: truncate(proposal.statement, 300),
          tainted: proposal.tainted === true,
          accepted: decision.accepted,
          reason: decision.reason,
          scores: decision.scores,
          ...(decision.recordId !== undefined ? { recordId: decision.recordId } : {}),
        },
      });
    }
  }

  /** Derive 1-3 episodic memory proposals from a completed run. */
  private deriveProposals(goal: Goal, outcome: AgentRunOutcome, tainted: boolean): MemoryProposal[] {
    const { result } = outcome;
    const proposals: MemoryProposal[] = [];
    const base = { sourceGoalId: goal.goalId, entities: [] as string[], tainted };
    // 1) The goal + its outcome status — the core episodic record.
    proposals.push({
      type: 'episodic',
      statement: `Goal "${truncate(goal.prompt, 160)}" finished with status ${result.status}: ${truncate(result.summary, 200)}`,
      ...base,
    });
    // 2) Failure episodes carry a strong don't-repeat-this signal.
    if (result.status === 'failed' || result.status === 'blocked') {
      proposals.push({
        type: 'episodic',
        statement: `Failure (${result.failureClass ?? 'unknown'}) while attempting "${truncate(goal.prompt, 140)}": ${truncate(result.summary, 200)}`,
        ...base,
      });
    } else if (outcome.finalText.trim().length > 0) {
      // 3) A successful run's final report can hold reusable how-to / facts.
      proposals.push({
        type: 'episodic',
        statement: `Outcome of "${truncate(goal.prompt, 140)}": ${truncate(outcome.finalText, 220)}`,
        ...base,
      });
    }
    return proposals;
  }

  /**
   * Run the policy gate for a tool call. Returns undefined to allow execution,
   * or a short-circuit { effect, reason, message } whose message is fed back to
   * the model as an error tool_result. Emits a policy.decision event for every
   * non-allow outcome. spawn_subagent is internal control flow (it spawns a
   * nested loop whose own tool calls are individually gated) and is not evaluated.
   */
  private enforcePolicy(
    call: ToolCallPart,
    taskId: string,
    agentRole: string,
  ): { effect: PolicyDecision['effect']; reason: string; message: string } | undefined {
    const policy = this.opts.policy;
    if (policy === undefined || call.name === 'spawn_subagent') return undefined;

    const ctx: ToolCallCtx = {
      projectId: this.opts.projectId,
      taskId,
      agentRole,
      tainted: this.opts.taint?.isTainted(taskId) === true,
    };
    const decision = policy.evaluate(call.name, call.args, ctx);
    if (decision.effect === 'allow') return undefined;

    // Record every non-allow decision on the event spine for audit.
    this.opts.events.append({
      projectId: this.opts.projectId,
      kind: 'policy.decision',
      taskId,
      agentId: agentRole,
      payload: {
        name: call.name,
        args: summarizeArgs(call.args),
        effect: decision.effect,
        reason: decision.reason,
        tainted: ctx.tainted,
        ...(decision.ruleIndex !== undefined ? { ruleIndex: decision.ruleIndex } : {}),
      },
    });

    if (decision.effect === 'deny') {
      return {
        effect: 'deny',
        reason: decision.reason,
        message: `Policy denied ${call.name}: ${decision.reason}. Adapt your plan and proceed without this action.`,
      };
    }

    // effect === 'queue'
    const approvals = this.opts.approvals;
    if (approvals === undefined) {
      // No human-approval sink wired: treat queue as deny-with-reason.
      return {
        effect: 'queue',
        reason: decision.reason,
        message: `Policy requires approval for ${call.name} (${decision.reason}), but no approval queue is configured, so it was not performed. Proceed without this action.`,
      };
    }
    let ticket: ApprovalTicket;
    try {
      ticket = approvals.create({
        projectId: this.opts.projectId,
        tool: call.name,
        args: call.args,
        reason: decision.reason,
        ...(this.opts.planEpoch !== undefined ? { planEpoch: this.opts.planEpoch } : {}),
      });
    } catch (e) {
      return {
        effect: 'queue',
        reason: decision.reason,
        message: `Policy requires approval for ${call.name} (${decision.reason}); queuing failed (${errorMessage(e)}). Proceed without this action.`,
      };
    }
    return {
      effect: 'queue',
      reason: decision.reason,
      message: `Action ${call.name} was queued for human approval (ticket ${ticket.ticketId}: ${decision.reason}). It was NOT performed. Continue with other work or finish; do not wait for the approval.`,
    };
  }

  /**
   * Mark the task tainted when a tool's output is an untrusted-content source.
   * Delegates the source decision to @lunaris/policy's classifyToolOutputTaints
   * (the single source of truth — FIX 4): web_fetch always taints; read_file
   * taints only when the path being read was previously written/derived from a
   * web_fetch in THIS task. Before classifying, it records derived paths so the
   * "fetched-then-read" flow is caught: a write_file done while the task is
   * already tainted produces untrusted bytes on disk.
   */
  private markTaintFor(call: ToolCallPart, taskId: string): void {
    const taint = this.opts.taint;
    if (taint === undefined) return;

    const alreadyTainted = taint.isTainted(taskId);
    // A file written while the task is tainted holds web-derived content; record
    // its path so a later read_file of it re-taints.
    if (alreadyTainted && (call.name === 'write_file' || call.name === 'apply_patch')) {
      const p = this.argPath(call.args);
      if (p !== undefined) {
        const set = this.derivedPaths.get(taskId) ?? new Set<string>();
        set.add(p);
        this.derivedPaths.set(taskId, set);
      }
    }

    const source = classifyToolOutputTaints(call.name, {
      args: call.args,
      derivedPaths: this.derivedPaths.get(taskId) ?? new Set<string>(),
    });
    if (source !== undefined) {
      taint.markTainted(taskId, source);
    }
  }

  /** Best-effort extraction of a path/file argument from opaque tool args. */
  private argPath(args: unknown): string | undefined {
    if (typeof args !== 'object' || args === null) return undefined;
    const a = args as Record<string, unknown>;
    if (typeof a['path'] === 'string') return a['path'];
    if (typeof a['file'] === 'string') return a['file'];
    return undefined;
  }

  private roles(): Record<string, RoleDef> {
    return this.opts.roles ?? builtinRoles;
  }

  /**
   * Build the per-run plugin-tool registry from the injected PluginHost (its
   * enabledTools()) and any pre-resolved `extraTools`. Names are namespaced
   * `<pluginId>/<tool>` by the host. `extraTools` is layered after the host so a
   * test/caller-supplied tool wins on a name clash; a built-in tool of the same
   * name still wins at dispatch/def time (see toolFor / toolDefsFor). A host that
   * throws contributes nothing — plugins are additive, never load-bearing.
   */
  private async resolvePluginTools(): Promise<void> {
    const map = new Map<string, ResolvedTool>();
    const host = this.opts.pluginHost;
    if (host !== undefined) {
      try {
        for (const tool of await host.enabledTools()) map.set(tool.def.name, tool);
      } catch {
        // Plugin resolution is best-effort; fall back to built-ins only.
      }
    }
    for (const tool of this.opts.extraTools ?? []) map.set(tool.def.name, tool);
    this.pluginTools = map;
  }

  private async runInternal(
    goal: Goal,
    roleName: string,
    depth: number,
    taskId: string,
  ): Promise<AgentRunOutcome> {
    const role = this.roles()[roleName];
    if (role === undefined) {
      return this.outcome(goal, taskId, '', 'failed', `unknown role: ${roleName}`, 'infra');
    }
    try {
      return await this.iterate(goal, role, depth, taskId);
    } catch (e) {
      // The loop itself should never throw; anything that escapes is infrastructure.
      return this.outcome(goal, taskId, '', 'failed', `internal error: ${errorMessage(e)}`, 'infra');
    }
  }

  private async iterate(
    goal: Goal,
    role: RoleDef,
    depth: number,
    taskId: string,
  ): Promise<AgentRunOutcome> {
    const { projectId } = this.opts;
    const maxIterations = role.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const toolDefs = this.toolDefsFor(role, depth);
    const journalPath = await this.openJournal(goal.goalId);
    const journal = (entry: Record<string, unknown>): Promise<void> =>
      appendFile(
        journalPath,
        `${JSON.stringify({ ts: new Date().toISOString(), goalId: goal.goalId, role: role.name, ...entry })}\n`,
        'utf8',
      );

    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: goal.prompt }] },
    ];
    let lastText = '';

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const req: UnifiedRequest = {
        model: role.model ?? this.opts.model,
        messages: [...messages],
        system: role.systemPrompt,
        tools: toolDefs,
        meta: { projectId, callId: randomUUID(), taskId, agentRole: role.name },
      };

      const turn = await this.streamTurn(req);
      if (turn.text.length > 0) lastText = turn.text;

      await journal({
        kind: 'llm.turn',
        iteration,
        model: req.model,
        text: turn.text,
        toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        stopReason: turn.stopReason,
        usage: turn.usage,
        error: turn.error,
      });

      if (turn.stopReason === 'error' || turn.error !== undefined) {
        return this.outcome(
          goal,
          taskId,
          lastText,
          'failed',
          `LLM error: ${turn.error ?? 'unknown'}`,
          'model',
          journalPath,
        );
      }

      const assistantContent: ContentPart[] = [];
      if (turn.text.length > 0) assistantContent.push({ type: 'text', text: turn.text });
      assistantContent.push(...turn.toolCalls);
      if (assistantContent.length > 0) {
        messages.push({ role: 'assistant', content: assistantContent });
      }

      if (turn.toolCalls.length === 0) {
        const summary = turn.text.length > 0 ? truncate(turn.text, 400) : 'completed (no final text)';
        return this.outcome(goal, taskId, lastText, 'success', summary, undefined, journalPath);
      }

      const resultParts: ToolResultPart[] = [];
      for (const call of turn.toolCalls) {
        // POLICY ENFORCEMENT: gate every tool call before it runs. A non-allow
        // decision short-circuits execution and feeds an advisory result back to
        // the model so it can adapt — the loop is never blocked.
        const gate = this.enforcePolicy(call, taskId, role.name);
        if (gate !== undefined) {
          await journal({
            kind: 'policy.decision',
            iteration,
            name: call.name,
            args: call.args,
            effect: gate.effect,
            reason: gate.reason,
          });
          resultParts.push({
            type: 'tool_result',
            toolCallId: call.id,
            content: gate.message,
            isError: true,
          });
          continue;
        }

        const startedAt = Date.now();
        let content: string;
        let isError = false;
        let infraError: string | undefined;
        try {
          content = await this.executeToolCall(call, role, depth);
        } catch (e) {
          isError = true;
          if (e instanceof ToolError) {
            content = e.message;
          } else {
            infraError = errorMessage(e);
            content = infraError;
          }
        }
        // TAINT: untrusted tool output (web fetch / file reads) taints the task,
        // so subsequent policy evaluations get the stricter overlay. Only mark on
        // a successful read of untrusted content.
        if (!isError && infraError === undefined) {
          this.markTaintFor(call, taskId);
        }
        const durationMs = Date.now() - startedAt;
        this.opts.events.append({
          projectId,
          kind: 'tool.call',
          taskId,
          agentId: role.name,
          payload: { name: call.name, args: summarizeArgs(call.args), durationMs, ok: !isError },
        });
        await journal({
          kind: 'tool.call',
          iteration,
          name: call.name,
          args: call.args,
          ok: !isError,
          durationMs,
          result: truncate(content, 2_000),
        });
        if (infraError !== undefined) {
          return this.outcome(
            goal,
            taskId,
            lastText,
            'failed',
            `tool ${call.name} crashed: ${infraError}`,
            'infra',
            journalPath,
          );
        }
        resultParts.push({
          type: 'tool_result',
          toolCallId: call.id,
          content,
          ...(isError ? { isError: true } : {}),
        });
      }
      messages.push({ role: 'tool', content: resultParts });
    }

    return this.outcome(
      goal,
      taskId,
      lastText,
      'partial',
      `stopped: reached the iteration budget (maxIterations=${maxIterations}) before finishing`,
      undefined,
      journalPath,
    );
  }

  /** Streams one gateway turn, collecting text, tool calls and the end state. */
  private async streamTurn(req: UnifiedRequest): Promise<TurnResult> {
    let text = '';
    const toolCalls: ToolCallPart[] = [];
    let stopReason: StopReason = 'end';
    let usage: Usage | undefined;
    let error: string | undefined;
    try {
      for await (const ev of this.opts.gateway.chat(req)) {
        switch (ev.type) {
          case 'text_delta':
            text += ev.text;
            break;
          case 'tool_call':
            toolCalls.push({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.args });
            break;
          case 'message_end':
            stopReason = ev.stopReason;
            usage = ev.usage;
            error = ev.error;
            break;
          case 'message_start':
            break;
        }
      }
    } catch (e) {
      stopReason = 'error';
      error = errorMessage(e);
    }
    return { text, toolCalls, stopReason, usage, error };
  }

  private async executeToolCall(call: ToolCallPart, role: RoleDef, depth: number): Promise<string> {
    if (!role.tools.includes(call.name)) {
      throw new ToolError(`tool not allowed for role "${role.name}": ${call.name}`);
    }
    if (call.name === 'spawn_subagent') {
      if (depth >= MAX_SPAWN_DEPTH) {
        throw new ToolError('spawn_subagent is not available to subagents (max depth 1)');
      }
      return this.spawnSubagent(call.args, depth);
    }
    const ctx = {
      projectId: this.opts.projectId,
      projectRoot: this.opts.projectRoot,
    };
    const tool = builtinTools.get(call.name);
    if (tool !== undefined) {
      return tool.execute(call.args, ctx);
    }
    // PLUGIN TOOL: dispatch to a namespaced <pluginId>/<tool> resolved for this
    // run. The plugin fn receives the same ToolContext opaquely (typed unknown
    // per the ResolvedTool contract); a non-string return is JSON-coerced by the
    // host's execute wrapper.
    const plugin = this.pluginTools.get(call.name);
    if (plugin !== undefined) {
      return plugin.execute(call.args, ctx);
    }
    throw new ToolError(`unknown tool: ${call.name}`);
  }

  /** spawn_subagent: run a nested AgentLoop (depth max 1) and return its final text. */
  private async spawnSubagent(args: unknown, depth: number): Promise<string> {
    const roleName = requireStringArg(args, 'role');
    const task = requireStringArg(args, 'task');
    const subRole = this.roles()[roleName];
    if (subRole === undefined) {
      throw new ToolError(`spawn_subagent: unknown role "${roleName}"`);
    }

    const taskId = randomUUID();
    const subGoal: Goal = {
      goalId: taskId,
      projectId: this.opts.projectId,
      prompt: task,
      createdAt: new Date().toISOString(),
      status: 'running',
    };
    this.opts.events.append({
      projectId: this.opts.projectId,
      kind: 'task.start',
      taskId,
      agentId: roleName,
      payload: { role: roleName, task: truncate(task, 500) },
    });

    // runInternal never throws; failures come back as a ResultEnvelope.
    const outcome = await this.runInternal(subGoal, roleName, depth + 1, taskId);
    this.opts.events.append({
      projectId: this.opts.projectId,
      kind: 'task.end',
      taskId,
      agentId: roleName,
      payload: outcome.result,
    });

    if (outcome.result.status === 'failed') {
      throw new ToolError(
        `subagent failed (${outcome.result.failureClass ?? 'unknown'}): ${outcome.result.summary}`,
      );
    }
    return outcome.finalText.length > 0 ? outcome.finalText : outcome.result.summary;
  }

  private toolDefsFor(role: RoleDef, depth: number): ToolDef[] {
    const defs: ToolDef[] = [];
    for (const name of role.tools) {
      if (name === 'spawn_subagent') {
        if (depth < MAX_SPAWN_DEPTH) defs.push(SPAWN_SUBAGENT_DEF);
        continue;
      }
      const builtin = builtinTools.get(name);
      if (builtin !== undefined) {
        defs.push(builtin.def);
        continue;
      }
      // A role may list a namespaced plugin tool (<pluginId>/<tool>); offer its
      // def when an enabled plugin contributed it.
      const plugin = this.pluginTools.get(name);
      if (plugin !== undefined) defs.push(plugin.def);
    }
    return defs;
  }

  private async openJournal(goalId: string): Promise<string> {
    const dir = path.join(path.resolve(this.opts.projectRoot), '.lunaris', 'journal');
    await mkdir(dir, { recursive: true });
    return path.join(dir, `${sanitizeForFilename(goalId)}.jsonl`);
  }

  private outcome(
    goal: Goal,
    taskId: string,
    finalText: string,
    status: ResultEnvelope['status'],
    summary: string,
    failureClass?: ResultEnvelope['failureClass'],
    journalPath?: string,
  ): AgentRunOutcome {
    const result: ResultEnvelope = {
      taskId,
      status,
      summary,
      ...(failureClass !== undefined ? { failureClass } : {}),
      ...(journalPath !== undefined ? { artifacts: [journalPath] } : {}),
    };
    const goalStatus: GoalStatus = status === 'success' ? 'done' : 'failed';
    return { goal: { ...goal, status: goalStatus }, finalText, result };
  }
}
