/**
 * scaffoldPlugin: write a starter plugin into a directory so `lun plugin new`
 * produces something that immediately loads + runs. Emits a `plugin.toml` and
 * an example `echo` tool module (CommonJS-free ESM with a default `execute`
 * export). The output round-trips through loadPluginManifest + the host.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_MANIFEST_FILE, PluginManifestError } from './manifest.js';

export interface ScaffoldPluginOptions {
  /** reverse-DNS plugin id, e.g. dev.acme.pg-tools. */
  id: string;
  /** human-readable name (used in the description). */
  name: string;
  /** initial version (default "0.1.0"). */
  version?: string;
  /** overwrite an existing plugin.toml instead of refusing (default false). */
  force?: boolean;
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function starterToml(opts: Required<Pick<ScaffoldPluginOptions, 'id' | 'name' | 'version'>>): string {
  return `# Lunaris plugin manifest. v1 supports tools + MCP server defs.
id = "${tomlEscape(opts.id)}"
version = "${tomlEscape(opts.version)}"
description = "${tomlEscape(opts.name)}"

# Each tool resolves to a named export (default "execute") in its module.
[[tools]]
name = "echo"
description = "Echo back the provided text."
module = "tools/echo.js"

[tools.inputSchema]
type = "object"

[tools.inputSchema.properties.text]
type = "string"
description = "The text to echo back."
`;
}

const ECHO_MODULE = `/**
 * Example Lunaris plugin tool. The host imports this module and calls the
 * named export (default "execute") as execute(args, ctx); the returned value is
 * coerced to a string by the host.
 */
export async function execute(args, _ctx) {
  const text = args && typeof args === 'object' ? args.text : undefined;
  return typeof text === 'string' ? text : String(text ?? '');
}
`;

/**
 * Scaffold a starter plugin at `dir`. Creates `dir` (and `dir/tools`) if
 * needed, writes `plugin.toml` + `tools/echo.js`. Throws PluginManifestError if
 * a plugin.toml already exists and `force` is not set.
 */
export function scaffoldPlugin(dir: string, opts: ScaffoldPluginOptions): void {
  const version = opts.version ?? '0.1.0';
  const manifestPath = join(dir, PLUGIN_MANIFEST_FILE);
  if (existsSync(manifestPath) && !opts.force) {
    throw new PluginManifestError(`Refusing to overwrite existing plugin: ${manifestPath}`);
  }
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(manifestPath, starterToml({ id: opts.id, name: opts.name, version }), 'utf8');
  writeFileSync(join(dir, 'tools', 'echo.js'), ECHO_MODULE, 'utf8');
}
