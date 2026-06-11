/**
 * MCP server defs for enabled plugins.
 *
 * v1 scope: this resolves the launch-spec list only — the flattened, namespaced
 * set of PluginMcpServerDef across enabled plugins. Actual MCP *client* wiring
 * (handshake, tool discovery over the protocol) is OUT of v1 scope.
 *
 * `startMcpServer` is a defensive stub: it spawns the declared command via
 * node:child_process and hands back the pid + a kill(). It is not exercised by
 * the test suite and exists so the launch path has a concrete entry point.
 */
import { spawn } from 'node:child_process';
import type { LoadedPlugin, PluginMcpServerDef } from '@lunaris/core';

/**
 * Flatten the MCP server defs of the given enabled plugins, namespacing each
 * server name as `<pluginId>/<serverName>` so names are globally unique. Only
 * enabled plugins contribute (disabled ones are ignored even if passed).
 */
export function resolveMcpServers(plugins: LoadedPlugin[]): PluginMcpServerDef[] {
  const out: PluginMcpServerDef[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    for (const s of p.manifest.mcpServers ?? []) {
      const def: PluginMcpServerDef = {
        name: `${p.manifest.id}/${s.name}`,
        command: s.command,
      };
      if (s.args !== undefined) def.args = [...s.args];
      if (s.env !== undefined) def.env = { ...s.env };
      out.push(def);
    }
  }
  return out;
}

export interface RunningMcpServer {
  pid: number | undefined;
  kill(): void;
}

/**
 * Defensive stub: spawn an MCP server process from its launch spec. Returns its
 * pid and a kill(). NOT required by v1 and NOT covered by tests — full MCP
 * client wiring is future work.
 */
export function startMcpServer(def: PluginMcpServerDef): RunningMcpServer {
  const child = spawn(def.command, def.args ?? [], {
    env: { ...process.env, ...(def.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    pid: child.pid,
    kill: () => {
      child.kill();
    },
  };
}
