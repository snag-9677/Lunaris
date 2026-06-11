/**
 * @lunaris/scheduler — goal queue + cron schedules + trigger rules + dispatcher.
 *
 * Local-first, dependency-free (node:sqlite + node:crypto), all stores follow
 * the SqliteEventStore/SqliteApprovalQueue pattern (WAL, uuidv7 ids). Time-
 * dependent logic accepts an injectable `now` for deterministic tests.
 */
export { parseCron, matches, nextRun, type ParsedCron } from './cron.js';
export {
  SqliteGoalQueue,
  type SqliteGoalQueueOptions,
} from './queue.js';
export {
  SqliteTemplateStore,
  renderTemplate,
  type CreateTemplateInput,
} from './templates.js';
export {
  SqliteScheduleStore,
  type CreateScheduleInput,
  type ScheduleStoreOptions,
  type EnqueueFn,
} from './schedules.js';
export {
  SqliteTriggerStore,
  verifyHmac,
  payloadToVars,
  type CreateTriggerInput,
} from './triggers.js';
export {
  Dispatcher,
  type DispatcherOptions,
  type RunGoalFn,
  type RunResult,
} from './dispatcher.js';
