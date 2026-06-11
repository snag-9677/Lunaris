export { buildServer } from './server.js';
export type { BuildServerOptions, LunarisServerContext } from './server.js';
export { ProjectRegistry, defaultRegistryPath } from './registry.js';
export type { RegisteredProject, RegistryData } from './registry.js';
export { defaultGoalRunner, memoryDbPath, approvalsDbPath } from './goal-runner.js';
export type { GoalRunner, GoalRunContext, AgentLoopExtras } from './goal-runner.js';
export {
  banditDbPath,
  proposalDbPath,
  queueDbPath,
  scheduleDbPath,
  triggerDbPath,
  pluginsDir,
  isSafePathSegment,
  webhookSecretFor,
} from './phase3.js';
export { startSchedulerLoop } from './scheduler-loop.js';
export type { SchedulerLoopHandle, StartSchedulerLoopOptions } from './scheduler-loop.js';
export { LeaseHeldError, acquireRunLease, withLease } from './goal-runner.js';
export type { GoalLeaseRuntime, AcquiredLease } from './goal-runner.js';
export {
  resolveAuthMode,
  defaultIdentityDbPath,
  setupIdentity,
  capabilityForRoute,
  projectIdFromPath,
  bearerFromRequest,
} from './auth.js';
export type { AuthMode, AuthContext, IdentityLike, IdentitySetup } from './auth.js';
export {
  leasesDbPath,
  agentKeyPath,
  makeLeaseRuntime,
  buildVersionReport,
  projectStorePaths,
  globalStorePaths,
} from './phase4.js';
export type { LeaseRuntime } from './phase4.js';
export { loadLifecyclePkg } from './lifecycle-routes.js';
export type { LifecyclePkgLike } from './lifecycle-routes.js';
