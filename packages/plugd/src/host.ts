/**
 * FilePluginHost: discovers plugin directories under a `pluginsDir`, tracks
 * enabled state in a JSON registry (or via injected ids), and resolves the
 * tools of enabled plugins into executable ResolvedTool entries for the
 * orchestrator registry.
 *
 * v1 scope: TOOLS + MCP SERVER DEFS only. No sandboxing.
 *
 * Discovery vs. execution boundary (important): list() and enable/disable NEVER
 * import or run plugin code — they only read plugin.toml. Plugin module code is
 * imported lazily, only by enabledTools() (and the execute() closures it
 * produces). A module that fails to import or lacks the named export is SKIPPED
 * and recorded in lastLoadErrors rather than throwing.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LoadedPlugin,
  PluginHost,
  PluginManifest,
  ResolvedTool,
  ToolDef,
} from '@lunaris/core';
import { PLUGIN_MANIFEST_FILE, loadPluginManifest } from './manifest.js';

const REGISTRY_FILE = 'plugins.json';
const DEFAULT_EXPORT = 'execute';

export interface FilePluginHostOptions {
  /** Root directory whose immediate subdirectories are candidate plugins. */
  pluginsDir: string;
  /**
   * If provided, this is the authoritative enabled-id set (registry file is not
   * read or written). Otherwise enabled state is read/persisted to the registry.
   */
  enabledIds?: string[];
  /** Override the registry path (defaults to <pluginsDir>/plugins.json). */
  registryPath?: string;
}

/** A plugin module that failed to load, with the reason it was skipped. */
export interface PluginLoadError {
  pluginId: string;
  toolName: string;
  module: string;
  reason: string;
}

interface RegistryShape {
  enabled: string[];
}

export class FilePluginHost implements PluginHost {
  private readonly pluginsDir: string;
  private readonly registryPath: string;
  /** Set when enabledIds is injected; disables registry persistence. */
  private readonly injectedEnabled?: Set<string>;
  private _lastLoadErrors: PluginLoadError[] = [];

  constructor(opts: FilePluginHostOptions) {
    this.pluginsDir = resolve(opts.pluginsDir);
    this.registryPath = opts.registryPath ?? join(this.pluginsDir, REGISTRY_FILE);
    if (opts.enabledIds !== undefined) {
      this.injectedEnabled = new Set(opts.enabledIds);
    }
  }

  /** Load errors recorded by the most recent enabledTools() call. */
  get lastLoadErrors(): PluginLoadError[] {
    return this._lastLoadErrors;
  }

  // ---------- discovery (no plugin code executed) ----------

  /** Discover plugin directories: immediate subdirs of pluginsDir with a plugin.toml. */
  private discover(): { manifest: PluginManifest; root: string }[] {
    if (!existsSync(this.pluginsDir)) return [];
    const out: { manifest: PluginManifest; root: string }[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(this.pluginsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const root = join(this.pluginsDir, ent.name);
      if (!existsSync(join(root, PLUGIN_MANIFEST_FILE))) continue;
      try {
        out.push({ manifest: loadPluginManifest(root), root });
      } catch {
        // A directory with an invalid manifest is not a loadable plugin; skip it.
      }
    }
    out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return out;
  }

  // ---------- enabled-state registry ----------

  private readEnabled(): Set<string> {
    if (this.injectedEnabled) return new Set(this.injectedEnabled);
    if (!existsSync(this.registryPath)) return new Set();
    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RegistryShape>;
      return new Set(Array.isArray(parsed.enabled) ? parsed.enabled : []);
    } catch {
      return new Set();
    }
  }

  private writeEnabled(ids: Set<string>): void {
    if (this.injectedEnabled) {
      // Injected mode is authoritative and in-memory; keep it consistent but
      // do not touch the registry file.
      this.injectedEnabled.clear();
      for (const id of ids) this.injectedEnabled.add(id);
      return;
    }
    const body: RegistryShape = { enabled: [...ids].sort() };
    writeFileSync(this.registryPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  // ---------- PluginHost ----------

  list(): LoadedPlugin[] {
    const enabled = this.readEnabled();
    return this.discover().map(({ manifest, root }) => ({
      manifest,
      root,
      enabled: enabled.has(manifest.id),
    }));
  }

  enable(id: string): void {
    const enabled = this.readEnabled();
    enabled.add(id);
    this.writeEnabled(enabled);
  }

  disable(id: string): void {
    const enabled = this.readEnabled();
    enabled.delete(id);
    this.writeEnabled(enabled);
  }

  /**
   * Resolve the tools of every enabled plugin into executable ResolvedTool
   * entries. Tool names are namespaced `<pluginId>/<toolName>`. A tool whose
   * module fails to import or lacks the named export is SKIPPED and recorded in
   * lastLoadErrors; this never throws for a bad plugin.
   */
  async enabledTools(): Promise<ResolvedTool[]> {
    const errors: PluginLoadError[] = [];
    const resolved: ResolvedTool[] = [];
    const enabled = this.readEnabled();

    for (const { manifest, root } of this.discover()) {
      if (!enabled.has(manifest.id)) continue;
      for (const tool of manifest.tools ?? []) {
        const exportName = tool.export ?? DEFAULT_EXPORT;
        const modulePath = resolve(root, tool.module);
        let fn: ((args: unknown, ctx: unknown) => unknown) | undefined;
        try {
          const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
          const candidate = mod[exportName];
          if (typeof candidate !== 'function') {
            errors.push({
              pluginId: manifest.id,
              toolName: tool.name,
              module: tool.module,
              reason:
                candidate === undefined
                  ? `missing export "${exportName}"`
                  : `export "${exportName}" is not a function`,
            });
            continue;
          }
          fn = candidate as (args: unknown, ctx: unknown) => unknown;
        } catch (err) {
          errors.push({
            pluginId: manifest.id,
            toolName: tool.name,
            module: tool.module,
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const def: ToolDef = {
          name: `${manifest.id}/${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
        const execFn = fn;
        resolved.push({
          def,
          pluginId: manifest.id,
          execute: async (args: unknown, ctx: unknown): Promise<string> => {
            const result = await execFn(args, ctx);
            return typeof result === 'string' ? result : JSON.stringify(result ?? null);
          },
        });
      }
    }

    this._lastLoadErrors = errors;
    return resolved;
  }
}
