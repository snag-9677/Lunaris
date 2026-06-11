/**
 * Shared data shapes for the Mission Control UI. These mirror the relevant
 * fields of @lunaris/core's wire types; the UI stays dependency-free and only
 * models what it renders. Do not change these without checking the daemon's
 * response shapes — they are the contract.
 */

/* ---------- live feed / chat (WS stream in App) ---------- */

export interface FeedEvent {
  eventId: string;
  ts: string;
  projectId: string;
  kind: string;
  taskId?: string;
  agentId?: string;
  payload: unknown;
}

export interface Project {
  id: string;
  name: string;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending: boolean;
  ts: string;
}

export type ChatsState = Record<string, ChatEntry[]>;
export type WsStatus = 'connecting' | 'open' | 'closed';

/* ---------- panels (mirror @lunaris/core) ---------- */

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

export interface MemoryRecord {
  id: string;
  type: string;
  statement: string;
  entities: string[];
  confidence: number;
  strength: number;
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

export interface ApprovalTicket {
  ticketId: string;
  projectId: string;
  tool: string;
  args: unknown;
  reason: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'denied' | 'stale';
}

export interface OutcomeStats {
  key: string;
  taskClass: string;
  role: string;
  model: string;
  n: number;
  successes: number;
  successRate: number;
  avgCostUsd: number;
}

export interface RoutingSuggestion {
  taskClass: string;
  recommendedModel: string;
  rationale: string;
  confidence: number;
  basedOnN: number;
}

export interface ConfigProposal {
  id: string;
  projectId: string;
  kind: 'routing' | 'capability' | 'prompt';
  title: string;
  detail: string;
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

export interface LoadedPlugin {
  manifest: { id: string; version: string; description?: string };
  root: string;
  enabled: boolean;
}

export interface Schedule {
  id: string;
  projectId: string;
  cron: string;
  prompt?: string;
  templateId?: string;
  enabled: boolean;
  nextRunAt?: string;
}

export interface QueuedGoal {
  id: string;
  projectId: string;
  prompt: string;
  priority: number;
  status: string;
  source: string;
  attempts: number;
  maxAttempts: number;
  goalId?: string;
}

export interface VersionInfo {
  harness: string;
  schemaVersions: Record<string, number>;
}

export interface StoreReport {
  store: string;
  path: string;
  present: boolean;
  version: number | null;
  expected: number | null;
  status: 'ok' | 'behind' | 'ahead' | 'missing';
}

export interface DoctorReport {
  harness: string;
  stores: StoreReport[];
}

export interface SnapshotInfo {
  id: string;
  projectId: string;
  createdAt: string;
  bytes: number;
  kind: 'full' | 'pre-op';
  path: string;
}

export interface LeaseInfo {
  repoId: string;
  holderId: string;
  nodeId: string;
  epoch: number;
  acquiredAt: string;
  heartbeatAt: string;
}
