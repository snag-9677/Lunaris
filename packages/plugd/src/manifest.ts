/**
 * Plugin manifest loading + validation.
 *
 * A plugin package is a directory containing a `plugin.toml` plus the tool
 * module files it references. `loadPluginManifest(dir)` parses that TOML
 * (smol-toml, matching @lunaris/core's manifest.ts) into a PluginManifest and
 * validates it with clear, path-prefixed error messages.
 *
 * v1 scope: TOOLS + MCP SERVER DEFS only. No UI panels, no inter-plugin
 * services, no sandboxing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type {
  PluginManifest,
  PluginMcpServerDef,
  PluginToolDef,
} from '@lunaris/core';

export const PLUGIN_MANIFEST_FILE = 'plugin.toml';

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

/** reverse-DNS id, e.g. dev.acme.pg-tools: >=2 dot-separated lowercase labels. */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
/** semver-ish: MAJOR.MINOR(.PATCH)? with optional -prerelease / +build. */
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Validate an already-parsed object as a PluginManifest. Collects all problems
 * and throws a single PluginManifestError listing them, prefixed by `source`.
 */
export function validatePluginManifest(
  data: unknown,
  source = PLUGIN_MANIFEST_FILE,
): PluginManifest {
  const errors: string[] = [];

  if (!isObject(data)) {
    throw new PluginManifestError(`Invalid plugin manifest at ${source}: expected a table`);
  }

  const id = asString(data['id']);
  if (id === undefined || id.length === 0) {
    errors.push('id: required (reverse-DNS, e.g. "dev.acme.pg-tools")');
  } else if (!ID_RE.test(id)) {
    errors.push(`id: "${id}" is not reverse-DNS (lowercase labels, >=2 dot-separated parts)`);
  }

  const version = asString(data['version']);
  if (version === undefined || version.length === 0) {
    errors.push('version: required (semver-ish, e.g. "1.0.0")');
  } else if (!VERSION_RE.test(version)) {
    errors.push(`version: "${version}" is not semver-ish (e.g. "1.0.0")`);
  }

  const description = asString(data['description']);
  const lunaris = asString(data['lunaris']);

  const tools: PluginToolDef[] = [];
  const rawTools = data['tools'];
  if (rawTools !== undefined) {
    if (!Array.isArray(rawTools)) {
      errors.push('tools: must be an array of tables');
    } else {
      rawTools.forEach((t, i) => {
        const where = `tools[${i}]`;
        if (!isObject(t)) {
          errors.push(`${where}: must be a table`);
          return;
        }
        const name = asString(t['name']);
        const module = asString(t['module']);
        if (name === undefined || name.length === 0) errors.push(`${where}.name: required`);
        if (module === undefined || module.length === 0) {
          errors.push(`${where}.module: required (path to a module exporting an execute fn)`);
        }
        const tool: PluginToolDef = {
          name: name ?? '',
          description: asString(t['description']) ?? '',
          inputSchema: isObject(t['inputSchema']) ? t['inputSchema'] : {},
          module: module ?? '',
        };
        const exp = asString(t['export']);
        if (exp !== undefined) tool.export = exp;
        tools.push(tool);
      });
    }
  }

  // Reject duplicate tool names within ONE manifest: two same-named tools would
  // resolve to colliding <id>/<name> ResolvedTools and the orchestrator's
  // map.set would silently let the later one shadow the earlier (FIX 4).
  const seenToolNames = new Set<string>();
  for (const t of tools) {
    if (t.name.length === 0) continue; // already flagged as a missing-name error above
    if (seenToolNames.has(t.name)) {
      errors.push(`tools: duplicate tool name "${t.name}" (tool names must be unique within a manifest)`);
    }
    seenToolNames.add(t.name);
  }

  const mcpServers: PluginMcpServerDef[] = [];
  const rawServers = data['mcpServers'];
  if (rawServers !== undefined) {
    if (!Array.isArray(rawServers)) {
      errors.push('mcpServers: must be an array of tables');
    } else {
      rawServers.forEach((s, i) => {
        const where = `mcpServers[${i}]`;
        if (!isObject(s)) {
          errors.push(`${where}: must be a table`);
          return;
        }
        const name = asString(s['name']);
        const command = asString(s['command']);
        if (name === undefined || name.length === 0) errors.push(`${where}.name: required`);
        if (command === undefined || command.length === 0) {
          errors.push(`${where}.command: required (executable to spawn)`);
        }
        const def: PluginMcpServerDef = {
          name: name ?? '',
          command: command ?? '',
        };
        if (Array.isArray(s['args'])) {
          def.args = (s['args'] as unknown[]).map((a) => String(a));
        }
        if (isObject(s['env'])) {
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(s['env'])) env[k] = String(v);
          def.env = env;
        }
        mcpServers.push(def);
      });
    }
  }

  const permissions: string[] = [];
  const rawPerms = data['permissions'];
  if (rawPerms !== undefined) {
    if (!Array.isArray(rawPerms)) {
      errors.push('permissions: must be an array of strings');
    } else {
      for (const p of rawPerms) permissions.push(String(p));
    }
  }

  if (errors.length > 0) {
    throw new PluginManifestError(
      `Invalid plugin manifest at ${source}:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  const manifest: PluginManifest = {
    id: id as string,
    version: version as string,
  };
  if (description !== undefined) manifest.description = description;
  if (lunaris !== undefined) manifest.lunaris = lunaris;
  if (tools.length > 0) manifest.tools = tools;
  if (mcpServers.length > 0) manifest.mcpServers = mcpServers;
  if (permissions.length > 0) manifest.permissions = permissions;
  return manifest;
}

/**
 * Parse and validate `<pluginDir>/plugin.toml`. Throws PluginManifestError with
 * a clear message when the file is missing, the TOML is malformed, or the
 * shape is invalid.
 */
export function loadPluginManifest(pluginDir: string): PluginManifest {
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new PluginManifestError(`Plugin manifest not found: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, 'utf8');
  let data: unknown;
  try {
    data = parseToml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PluginManifestError(`Invalid TOML in ${manifestPath}: ${msg}`);
  }
  return validatePluginManifest(data, manifestPath);
}
