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

// ---------- Optimizer (recursive self-optimization, propose-only v1) ----------

export interface TaskOutcome {
  taskId: string;
  projectId: string;
  taskClass: string; // 'code' | 'research' | 'test' | 'chat' | ...
  role: string;
  model: string;
  status: 'success' | 'partial' | 'failed' | 'blocked';
  /** infra failures are excluded from model/prompt quality stats. */
  failureClass?: FailureClass;
  costUsd: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  ts: string;
}

export interface OutcomeStats {
  key: string; // "<taskClass>/<role>/<model>"
  taskClass: string;
  role: string;
  model: string;
  n: number;
  successes: number;
  /** Wilson lower bound on success rate. */
  successRate: number;
  avgCostUsd: number;
  avgDurationMs: number;
}

/** One arm of the per-task-class routing bandit. */
export interface RoutingArm {
  taskClass: string;
  model: string;
  pulls: number;
  reward: number; // cumulative
  meanReward: number;
}

export interface RoutingSuggestion {
  taskClass: string;
  recommendedModel: string;
  rationale: string;
  confidence: number; // 0..1
  basedOnN: number;
}

export type ProposalKind = 'routing' | 'capability' | 'prompt';

/** Optimizer output is ALWAYS a proposal — never auto-applied in v1. */
export interface ConfigProposal {
  id: string;
  projectId: string;
  kind: ProposalKind;
  title: string;
  detail: string;
  /** human-readable suggested change, e.g. a routing-table diff. */
  diff?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  confidence: number;
}

export interface OptimizerReport {
  projectId: string;
  generatedAt: string;
  stats: OutcomeStats[];
  routing: RoutingSuggestion[];
  proposals: ConfigProposal[];
  notes: string[];
}

// ---------- Plugins (plugd, v1: tools + MCP server defs only) ----------

export interface PluginToolDef extends ToolDef {
  /** module path relative to plugin root exporting an execute fn. */
  module: string;
  /** named export, default 'execute'. */
  export?: string;
}

export interface PluginMcpServerDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PluginManifest {
  id: string; // reverse-DNS, e.g. dev.acme.pg-tools
  version: string;
  description?: string;
  /** harness compat semver range. */
  lunaris?: string;
  tools?: PluginToolDef[];
  mcpServers?: PluginMcpServerDef[];
  /** requested capabilities — advisory in v1, surfaced at install. */
  permissions?: string[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  root: string;
  enabled: boolean;
}

/** A plugin tool resolved to an executable, ready for the orchestrator registry. */
export interface ResolvedTool {
  def: ToolDef;
  pluginId: string;
  execute(args: unknown, ctx: unknown): Promise<string>;
}

export interface PluginHost {
  list(): LoadedPlugin[];
  enable(id: string): void;
  disable(id: string): void;
  /** resolved tools of all enabled plugins, namespaced <pluginId>/<tool>. */
  enabledTools(): Promise<ResolvedTool[]>;
}

// ---------- Scheduler / triggers / goal queue ----------

export type QueuedGoalStatus = 'queued' | 'leased' | 'done' | 'failed' | 'dead';

export interface QueuedGoal {
  id: string;
  projectId: string;
  prompt: string;
  priority: number; // higher runs first
  status: QueuedGoalStatus;
  /** 'cli' | 'ui' | 'schedule:<id>' | 'webhook:<source>' */
  source: string;
  notBefore?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  leasedAt?: string;
  /** the orchestrator run id this produced once dispatched. */
  goalId?: string;
  lastError?: string;
}

export interface GoalTemplate {
  id: string;
  name: string;
  /** placeholders {{var}} filled from schedule/trigger vars. */
  promptTemplate: string;
}

export interface Schedule {
  id: string;
  projectId: string;
  cron: string; // 5-field
  templateId?: string;
  prompt?: string; // inline alternative to a template
  vars?: Record<string, string>;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface TriggerRule {
  id: string;
  projectId: string;
  source: string; // 'github' | 'generic'
  eventTypes: string[];
  promptTemplate: string;
  enabled: boolean;
}

export interface GoalQueue {
  push(
    g: Omit<QueuedGoal, 'id' | 'status' | 'attempts' | 'createdAt'> & { maxAttempts?: number },
  ): QueuedGoal;
  /** highest-priority eligible goal (status queued, notBefore<=now), marked leased. */
  lease(now?: Date): QueuedGoal | null;
  complete(id: string, goalId: string): void;
  fail(id: string, retry: boolean, error?: string): void;
  list(projectId?: string, status?: QueuedGoalStatus): QueuedGoal[];
}

// ---------- Identity, auth, RBAC (Phase 4: lunaris-id) ----------

export type PrincipalKind = 'user' | 'node' | 'agent' | 'service';

export interface Principal {
  id: string; // usr_/node_/agt_/svc_ + ulid
  kind: PrincipalKind;
  displayName: string;
  createdAt: string;
  status: 'active' | 'suspended';
  /** agent principals are parented to the user/service that started the run. */
  parentId?: string;
}

/** RBAC role (distinct from the chat-message Role and subagent RoleDef). */
export type RbacRole = 'owner' | 'maintainer' | 'operator' | 'viewer' | 'auditor';

export interface RoleBinding {
  principalId: string;
  scope: string; // 'global' | 'project:<id>'
  role: RbacRole;
}

/** Dangerous powers gated by RBAC + (some) step-up. */
export type Capability =
  | 'project.read'
  | 'goal.submit'
  | 'kill_switch'
  | 'resume'
  | 'approve'
  | 'change_autonomy'
  | 'secrets.read'
  | 'secrets.write'
  | 'providers.write'
  | 'memory.prune'
  | 'optimizer.promote'
  | 'fleet.manage';

export interface Session {
  id: string;
  principalId: string;
  createdAt: string;
  expiresAt: string;
  /** last step-up (fresh second factor) timestamp, for dangerous ops. */
  stepUpAt?: string;
}

export interface AuthResult {
  ok: boolean;
  principal?: Principal;
  session?: Session;
  /** opaque bearer token for CLI/API (UI uses cookies in a full deployment). */
  token?: string;
  reason?: string;
}

/** Identity + RBAC control plane (embedded by default). */
export interface IdentityStore {
  createUser(displayName: string, password?: string): Principal;
  authenticate(displayName: string, password: string, now?: Date): AuthResult;
  /** Validate a bearer token → its live session + principal. */
  resolveToken(token: string, now?: Date): { principal: Principal; session: Session } | null;
  bind(principalId: string, scope: string, role: RbacRole): void;
  roleFor(principalId: string, projectId: string): RbacRole | null;
  can(principalId: string, projectId: string, cap: Capability): boolean;
  revokeSession(sessionId: string): void;
}

/**
 * Attenuable agent capability token (spec §15): minted per run, scoped to a
 * project/run/lease-epoch + a capability set. Subagents ATTENUATE (only shrink
 * the cap set), never escalate. Verified offline against the signing key.
 */
export interface AgentToken {
  principalId: string; // agt_*
  projectId: string;
  runId: string;
  leaseEpoch: number;
  caps: string[]; // e.g. ['fs.write:/repo', 'exec', 'net', 'provider:ollama', 'spawn']
  expiresAt: string;
}

export interface CapabilityTokenService {
  mint(t: Omit<AgentToken, 'expiresAt'> & { ttlMs?: number }): string; // signed string
  /** Verify signature + expiry; returns the decoded token or null. */
  verify(signed: string, now?: Date): AgentToken | null;
  /** Re-sign a strict subset of caps (attenuation only; rejects escalation). */
  attenuate(signed: string, caps: string[]): string;
}

// ---------- Distributed orchestrator lease + fencing (Phase 4) ----------

export interface Lease {
  repoId: string;
  holderId: string; // the orchestrator run/principal holding it
  nodeId: string;
  epoch: number; // monotonic; increments on each fresh acquisition
  acquiredAt: string;
  heartbeatAt: string;
  ttlMs: number;
}

/**
 * One-orchestrator-per-repo lease with fencing (replaces a plain lockfile).
 * Side-effecting writes are stamped with the held epoch; a stale epoch is
 * rejected so a paused-then-resumed zombie can't clobber a newer holder.
 */
export interface LeaseStore {
  /** Acquire if free or expired; null if a fresh lease is held by another. */
  acquire(repoId: string, holderId: string, nodeId: string, now?: Date): Lease | null;
  heartbeat(repoId: string, holderId: string, now?: Date): boolean;
  release(repoId: string, holderId: string): void;
  current(repoId: string, now?: Date): Lease | null;
  /** True iff epoch matches the current lease (fencing check before a write). */
  isCurrentEpoch(repoId: string, epoch: number, now?: Date): boolean;
}

// ---------- Lifecycle: snapshot / restore / bundle / identity v2 (Phase 4) ----------

/** T0 committed · T1 instance · T2 cache · T3 secret · T4 derived. */
export type StateTier = 'committed' | 'instance' | 'cache' | 'secret' | 'derived';

export interface SnapshotInfo {
  id: string;
  projectId: string;
  createdAt: string;
  bytes: number;
  kind: 'full' | 'pre-op';
  path: string;
}

export interface BundleManifest {
  formatVersion: number;
  /** committed lineage id (travels with clones). */
  projectId: string;
  name: string;
  createdAt: string;
  contents: string[]; // subsystem state included
  schemaVersions: Record<string, number>;
}

/** Two-level identity: committed lineage projectId + machine-local instanceId. */
export interface ProjectIdentity {
  projectId: string; // committed, in lunaris.toml
  instanceId: string; // minted per machine; keys secrets + local state
  fingerprint?: string; // canonical remote + root commit, for fork detection
}

// ---------- Schema migration / versioning (Phase 4) ----------

export interface VersionInfo {
  harness: string; // semver of the binary
  schemaVersions: Record<string, number>; // per-store ('events','memory',...)
}

export interface MigrationStep {
  store: string;
  from: number;
  to: number;
  description: string;
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
