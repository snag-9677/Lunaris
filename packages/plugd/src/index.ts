/**
 * @lunaris/plugd — plugin host for Lunaris.
 *
 * v1 surface: load + validate plugin manifests, discover plugins on disk,
 * enable/disable them (persisted to a JSON registry), and resolve the tools of
 * enabled plugins into executable, namespaced ResolvedTool entries. MCP server
 * defs are resolved to a launch-spec list; full MCP client wiring is future work.
 */
export {
  PLUGIN_MANIFEST_FILE,
  PluginManifestError,
  loadPluginManifest,
  validatePluginManifest,
} from './manifest.js';
export {
  FilePluginHost,
  type FilePluginHostOptions,
  type PluginLoadError,
} from './host.js';
export {
  resolveMcpServers,
  startMcpServer,
  type RunningMcpServer,
} from './mcp.js';
export { scaffoldPlugin, type ScaffoldPluginOptions } from './scaffold.js';
