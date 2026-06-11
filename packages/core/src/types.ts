/**
 * Lunaris shared contracts. Every package codes against these types.
 * Provider/model addressing: "<provider>/<model>", e.g. "anthropic/claude-sonnet-4-6",
 * "deepseek/deepseek-chat", "ollama/qwen3:8b", "mock/echo".
 */

// ---------- LLM: unified request/response ----------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  role: Role;
  content: ContentPart[];
}

/** Tool definition; inputSchema is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CallMeta {
  projectId: string;
  callId: string;
  taskId?: string;
  agentRole?: string;
}

export interface UnifiedRequest {
  /** "<provider>/<model>" */
  model: string;
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  meta: CallMeta;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type StopReason = 'end' | 'tool_calls' | 'max_tokens' | 'error';

export type UnifiedEvent =
  | { type: 'message_start'; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'message_end'; stopReason: StopReason; usage: Usage; error?: string };

/** One provider backend (anthropic | openai | deepseek | ollama | mock). */
export interface ProviderAdapter {
  id: string;
  /** Stream a completion. Must always terminate with a message_end event. */
  chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent>;
}

export interface ModelInfo {
  provider: string;
  model: string;
  contextWindow: number;
  usdPerMTokIn: number;
  usdPerMTokOut: number;
}

// ---------- Budget ----------

export interface BudgetCaps {
  perCallUsd?: number;
  perTaskUsd?: number;
  perDayUsd?: number;
}

/**
 * Transactional budget ledger (spec §2.7): atomic reserve at admission,
 * settle on completion, refund on failure. Reservations count immediately;
 * concurrent callers cannot collectively overshoot a cap.
 */
export interface BudgetLedger {
  /** Throws BudgetExceededError if the reservation would breach a cap. */
  reserve(meta: CallMeta, estimatedUsd: number): Reservation;
}

export interface Reservation {
  id: string;
  settle(actualUsd: number): void;
  refund(): void;
}

// ---------- Event spine ----------

/**
 * Append-only event envelope. kind is dot-namespaced:
 * llm.call | tool.call | task.start | task.end | goal.created | chat.message | ...
 */
export interface EventEnvelope {
  eventId: string; // UUIDv7 (time-ordered)
  ts: string; // ISO 8601
  projectId: string;
  kind: string;
  taskId?: string;
  agentId?: string;
  payload: unknown;
}

export interface EventStore {
  append(e: Omit<EventEnvelope, 'eventId' | 'ts'>): EventEnvelope;
  query(opts: { projectId?: string; kind?: string; limit?: number }): EventEnvelope[];
  subscribe(fn: (e: EventEnvelope) => void): () => void;
}

// ---------- Orchestrator ----------

export type GoalStatus = 'running' | 'done' | 'failed' | 'blocked';

export interface Goal {
  goalId: string;
  projectId: string;
  prompt: string;
  createdAt: string;
  status: GoalStatus;
}

export type FailureClass = 'infra' | 'model' | 'policy-denied' | 'user-cancelled';

export interface ResultEnvelope {
  taskId: string;
  status: 'success' | 'partial' | 'failed' | 'blocked';
  summary: string;
  failureClass?: FailureClass;
  artifacts?: string[];
}

/** A subagent role: prompt frame + tool allowlist + model binding. */
export interface RoleDef {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: string; // defaults to project default
  maxIterations?: number;
}

// ---------- Memory (graphified, guide-not-oracle) ----------

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export interface MemoryRecord {
  id: string;
  projectId: string;
  type: MemoryType;
  statement: string;
  entities: string[];
  /** 0..1 — how much to trust this; injected as advisory marker. */
  confidence: number;
  /** 0..1 — decays over time, reinforced on helpful use. */
  strength: number;
  createdAt: string;
  lastUsedAt?: string;
  sourceGoalId?: string;
  /** True if derived from untrusted (tainted) content. */
  tainted?: boolean;
}

export interface MemoryEntity {
  name: string;
  kind?: string;
  communityId?: number;
}

export interface MemoryRelation {
  from: string;
  to: string;
  rel: string;
  recordId: string;
}

export interface MemoryProposal {
  type: MemoryType;
  statement: string;
  entities: string[];
  sourceGoalId?: string;
  tainted?: boolean;
}

export interface RetentionDecision {
  accepted: boolean;
  scores: { novelty: number; utility: number; generality: number };
  reason: string;
  recordId?: string;
}

export interface MemoryBrief {
  /** Advisory block for prompt injection; includes confidence/staleness markers. */
  text: string;
  recordIds: string[];
}

/** Per-project graph memory. Agents never write directly — they propose. */
export interface MemoryStore {
  propose(p: MemoryProposal): RetentionDecision;
  search(query: string, limit?: number): MemoryRecord[];
  brief(taskPrompt: string, budgetChars?: number): MemoryBrief;
  reinforce(recordId: string, helpful: boolean): void;
  entities(): MemoryEntity[];
  relations(): MemoryRelation[];
  /** Apply decay + prune weak records; returns pruned count. */
  prune(): number;
}

// ---------- Autonomy policy (PDP) ----------

/** 0 read-only · 1 supervised · 2 autonomous-in-workspace · 3 full-auto */
export type AutonomyLevel = 0 | 1 | 2 | 3;

export type PolicyEffect = 'allow' | 'deny' | 'queue';

export interface PolicyRule {
  effect: PolicyEffect;
  /** Tool names this rule matches (glob ok); omitted = all. */
  tools?: string[];
  /** Globs over run_bash command text. */
  commands?: string[];
  /** Globs over file paths (relative to project root). */
  paths?: string[];
  /** Hostname globs for web_fetch. */
  domains?: string[];
  /** Rule applies only when context taint matches. */
  whenTainted?: boolean;
  reason?: string;
}

export interface ToolCallCtx {
  projectId: string;
  taskId?: string;
  agentRole?: string;
  /** Context has ingested untrusted content (web fetch etc.). */
  tainted: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  ruleIndex?: number;
}

export interface PolicyEngine {
  readonly level: AutonomyLevel;
  evaluate(tool: string, args: unknown, ctx: ToolCallCtx): PolicyDecision;
}

export interface ApprovalTicket {
  ticketId: string;
  projectId: string;
  tool: string;
  args: unknown;
  reason: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'denied' | 'stale';
  resolvedAt?: string;
  resolvedBy?: string;
  /** Staleness guard (spec §6): plan epoch at queue time. */
  planEpoch?: number;
}

// ---------- Analytics ----------

export interface ModelUsageRow {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ProjectAnalytics {
  projectId: string;
  since: string;
  goals: { total: number; done: number; failed: number; running: number };
  llm: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  byModel: ModelUsageRow[];
  tools: { calls: number; failures: number };
}

// ---------- Manifest (lunaris.toml) ----------

export interface ProviderConfig {
  baseUrl?: string;
  /** Name of the env var holding the API key (never the key itself). */
  keyEnv?: string;
}

export interface LunarisManifest {
  project: {
    id: string;
    name: string;
  };
  models: {
    /** "<provider>/<model>" */
    default: string;
    roles?: Record<string, string>;
  };
  providers?: Record<string, ProviderConfig>;
  budgets?: BudgetCaps;
  devenv?: {
    provisioner?: 'devcontainer' | 'nix' | 'dockerfile' | 'probe';
  };
}
