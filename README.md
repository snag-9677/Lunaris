# Lunaris

Local-first, autonomous, multi-project AI development harness. Full design: [LUNARIS_SPEC.md](LUNARIS_SPEC.md).

**Status: Phase 1 MVP.** Working slice: per-project manifest (`lunaris.toml`), multi-provider model gateway (Anthropic / OpenAI / DeepSeek / Ollama / mock) with transactional budget ledger, orchestrator agent loop with confined tools + one-level subagent spawn, SQLite event spine, local daemon (`lunarisd`, 127.0.0.1 only) with WS event stream, Mission Control web UI, `lun` CLI.

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
| `@lunaris/cli` | `lun`: init, chat, status, events, daemon |
| `@lunaris/ui` | Mission Control: project picker, chat, live event feed (Vite + React) |

## Roadmap

Spec §17: Phase 2 = memory graph + autonomy policy + dashboards; Phase 3 = optimizer + plugins + scheduler; Phase 4 = fleet/multi-user + lifecycle.
