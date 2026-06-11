export {
  builtinTools,
  getTool,
  requireStringArg,
  resolveWithinRoot,
  ToolError,
  type BuiltinTool,
  type ToolContext,
} from './tools.js';
export { builtinRoles, getRole, CODER_ROLE, ORCHESTRATOR_ROLE } from './roles.js';
export {
  AgentLoop,
  type AgentLoopOptions,
  type AgentRunOutcome,
  type ChatGateway,
  type TaintSink,
  type ApprovalSink,
  type CapTokenService,
} from './loop.js';
