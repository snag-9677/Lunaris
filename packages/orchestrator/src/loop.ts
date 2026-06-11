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
  ChatMessage,
  ContentPart,
  EventStore,
  Goal,
  GoalStatus,
  ResultEnvelope,
  RoleDef,
  StopReason,
  ToolCallPart,
  ToolDef,
  ToolResultPart,
  UnifiedEvent,
  UnifiedRequest,
  Usage,
} from '@lunaris/core';
import { builtinRoles } from './roles.js';
import { builtinTools, requireStringArg, ToolError } from './tools.js';

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
  constructor(private readonly opts: AgentLoopOptions) {}

  async run(goal: Goal, role = 'orchestrator'): Promise<AgentRunOutcome> {
    return this.runInternal(goal, role, 0, goal.goalId);
  }

  // ----- internals -----

  private roles(): Record<string, RoleDef> {
    return this.opts.roles ?? builtinRoles;
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
    const tool = builtinTools.get(call.name);
    if (tool === undefined) {
      throw new ToolError(`unknown tool: ${call.name}`);
    }
    return tool.execute(call.args, {
      projectId: this.opts.projectId,
      projectRoot: this.opts.projectRoot,
    });
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
      const tool = builtinTools.get(name);
      if (tool !== undefined) defs.push(tool.def);
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
