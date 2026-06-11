# Lunaris

Local-first, autonomous, multi-project AI development harness. Full design: [LUNARIS_SPEC.md](LUNARIS_SPEC.md).

**Status: Phase 3.** Phase 1 (per-project manifest, multi-provider gateway + transactional budget ledger, orchestrator agent loop, SQLite event spine, `lunarisd` daemon 127.0.0.1-only + WS, Mission Control UI, `lun` CLI) + Phase 2 (graphified memory, autonomy policy + taint + approvals, analytics) + Phase 3: recursive self-optimizer (outcome ledger over the event spine, Wilson-bounded success stats, per-task-class routing bandit, propose-only config proposals — no auto-apply), plugin host (`plugin.toml`, contributed tools + MCP server defs, enable/disable, policy-gated execution), and scheduler (goal queue, cron schedules, trigger rules, HMAC webhook intake, dispatcher). 233 tests.

## Quickstart

```sh
pnpm install
pnpm build
pnpm test                # 56 tests
node scripts/smoke.mjs   # end-to-end smoke (mock provider, no API keys needed)
```

Use it on a project:

```sh
cd ~/some-repo
node /path/to/lunaris/packages/cli/dist/main.js init --name my-project
# edit lunaris.toml: set models.default, e.g. "anthropic/claude-sonnet-4-6"
export ANTHROPIC_API_KEY=...   # or DEEPSEEK_API_KEY / OPENAI_API_KEY / local ollama
node /path/to/lunaris/packages/cli/dist/main.js chat "add a healthcheck endpoint"
```

Daemon + UI:

```sh
node packages/daemon/dist/main.js   # http://127.0.0.1:7340 (serves packages/ui/dist)
```

## Packages

| Package | What |
|---|---|
| `@lunaris/core` | Shared contracts, `lunaris.toml` manifest (zod), UUIDv7 ids, SQLite event store |
| `@lunaris/gateway` | ModelGateway: streaming adapters (Anthropic, OpenAI-compatible, Ollama, mock), pricing, transactional BudgetLedger |
| `@lunaris/orchestrator` | AgentLoop: roles, confined tools (read/write/list/bash), subagent spawn, JSONL journal |
| `@lunaris/daemon` | `lunarisd`: HTTP+WS API on 127.0.0.1:7340, project registry, async goal runner |
| `@lunaris/memory` | Graphified memory: SQLite store, selective-retention gate, lexical/embedding similarity, community clustering, decay/prune, advisory briefs |
| `@lunaris/policy` | PDP: rule engine (allow/deny/queue), autonomy levels, irreversible-action class, taint tracker, SQLite approval queue |
| `@lunaris/optimizer` | Recursive self-optimizer: outcome ledger, Wilson success stats, routing bandit, propose-only config proposals |
| `@lunaris/plugd` | Plugin host: `plugin.toml` manifests, contributed tools + MCP server defs, enable/disable registry, scaffold |
| `@lunaris/scheduler` | Goal queue, cron parser, schedules, trigger rules, HMAC webhook routing, dispatcher |
| `@lunaris/cli` | `lun`: init, chat, status, events, memory, analytics, approvals, optimize, proposals, plugins, schedule, queue, daemon |
| `@lunaris/ui` | Mission Control: chat + live feed + analytics / memory-graph / approvals / optimize / plugins / automation panels (Vite + React) |

## Roadmap

Spec §17: ~~Phase 2 = memory graph + autonomy policy + dashboards~~ (done); ~~Phase 3 = optimizer + plugins + scheduler~~ (done); Phase 4 = fleet/multi-user + lifecycle (self-upgrade, backup/restore, identity/auth).
