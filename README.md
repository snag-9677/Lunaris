# Lunaris

Local-first, autonomous, multi-project AI development harness. Full design: [LUNARIS_SPEC.md](LUNARIS_SPEC.md).

**Status: Phase 4 — feature-complete vs the spec.** Phase 1 (per-project manifest, multi-provider gateway + transactional budget ledger, orchestrator agent loop, SQLite event spine, `lunarisd` daemon 127.0.0.1-only + WS, Mission Control UI, `lun` CLI) + Phase 2 (graphified memory, autonomy policy + taint + approvals, analytics) + Phase 3 (recursive self-optimizer, plugin host, scheduler/triggers) + Phase 4: identity/auth/RBAC (scrypt passwords, hashed bearer tokens, role→capability matrix; auth off by default for loopback), attenuable Ed25519 agent capability tokens (subagents can only shrink caps), distributed one-orchestrator-per-repo lease with epoch fencing, lifecycle (snapshot/restore + export/import bundle + two-level project identity + `lun adopt`), and a schema-migration/version/doctor framework. All crypto via node:crypto (no native deps). 314 tests.

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
| `@lunaris/identity` | Control plane: principals, scrypt auth + sessions, RBAC role→capability matrix, Ed25519 attenuable capability tokens, lease store with epoch fencing |
| `@lunaris/lifecycle` | Snapshot/restore, export/import bundle, two-level project identity (committed lineage + machine-local instance), `adopt` |
| `@lunaris/cli` | `lun`: init, chat, status, events, memory, analytics, approvals, optimize, proposals, plugins, schedule, queue, login, whoami, snapshot, restore, export, adopt, lease, version, daemon |
| `@lunaris/ui` | Mission Control: chat + live feed + analytics / memory-graph / approvals / optimize / plugins / automation / system panels, optional login (Vite + React) |

core also carries: analytics rollups, schema migration + version + doctor.

## Roadmap

Spec §17: ~~Phase 2 = memory graph + autonomy policy + dashboards~~ (done); ~~Phase 3 = optimizer + plugins + scheduler~~ (done); ~~Phase 4 = fleet/multi-user + lifecycle~~ (done). All four phases implemented. Deferred past v1 (noted in spec): optimizer golden-eval A/B harness, plugin UI panels + sandboxing, lifecycle state-sync/merge/team-memory, external control-plane (Postgres) fleet mode, harness self-update binary slots.
