# Lunaris

Local-first, autonomous, multi-project AI development harness. Full design: [LUNARIS_SPEC.md](LUNARIS_SPEC.md).

Every repository gets its own hermetic AI environment (manifest + lockfile). A persistent per-project **orchestrator** decomposes goals into task DAGs and runs them unattended via specialized subagents, consulting a per-project knowledge-graph **memory** that acts as an advisory guide. All LLM traffic flows through one multi-provider **gateway**; every action lands on an append-only **event spine** that powers live observability, analytics, and a recursive self-**optimizer**. A **policy** engine + capability tokens keep unattended runs safe; **identity/RBAC**, **leases**, **lifecycle** (snapshot/restore/bundle), and a **plugin** host round it out. A **Mission Control** web UI is the single pane of glass.

**Status: feature-complete vs the spec (4 phases).** 13 packages · 314 tests · `node scripts/smoke.mjs` exercises all four phases offline with the mock provider. All crypto via `node:crypto` (no native deps); storage via `node:sqlite`.

---

## Requirements

- **Node ≥ 22** (uses built-in `node:sqlite`, `fetch`, `node:test`)
- **pnpm ≥ 9**

## Install & build

```sh
pnpm install
pnpm build          # tsc across all packages (topological)
pnpm test           # 314 tests
node scripts/smoke.mjs   # end-to-end, mock provider, no API keys needed
```

The CLI binary is `lunaris`; the daemon is `lunarisd`. Until published, invoke them by path (`node packages/cli/dist/main.js …`) or `pnpm --filter @lunaris/cli exec lunaris …`, or `npm link` the cli package for a global `lunaris`.

---

## Quickstart

### 1. Initialize a project

```sh
cd ~/your-repo
lunaris init --name your-repo
```

This writes `lunaris.toml` and a `.lunaris/` state dir. Default model is `mock/echo` (offline, no key) so you can try the loop immediately:

```sh
lunaris chat "create a hello.txt that says hi, then summarize what you did"
lunaris status        # project id, name, default model, event count
lunaris events --tail 20
```

### 2. Wire a real model

Edit `lunaris.toml` → `[models] default`, then put the key in the project's `.aienv` file (`lunaris init` already scaffolded `.aienv.sample` and gitignored `.aienv`):

```sh
cp .aienv.sample .aienv          # then edit and fill in the keys you use
#   ANTHROPIC_API_KEY=sk-ant-...
#   DEEPSEEK_API_KEY=...
# (Ollama needs no key — just a running local server)
lunaris chat "add a /health endpoint and a test for it"
```

`.aienv` is loaded per project — by the CLI from the project dir, by the daemon per goal run — and merged into the environment **without overwriting** anything already exported in your shell (so a real `export` still wins, and CI can inject keys the usual way). Keys are never written to `lunaris.toml`, logs, or the event spine.

### 3. Daemon + Mission Control UI

```sh
# Terminal A — the daemon (HTTP+WS on 127.0.0.1:7340, loopback only)
node packages/daemon/dist/main.js
#   or: lunaris daemon --port 7340

# Terminal B — the UI dev server (proxies /api to the daemon)
pnpm --filter @lunaris/ui dev
#   the daemon also serves the built UI from packages/ui/dist at http://127.0.0.1:7340
```

Register a project with the daemon, then drive it from chat or the UI:

```sh
curl -X POST 127.0.0.1:7340/api/projects -H 'content-type: application/json' \
  -d '{"root":"/abs/path/to/your-repo"}'
```

---

## Configuration — `lunaris.toml`

Committed to the repo; secrets are referenced by env-var name, never stored.

```toml
[project]
id = "0192..."          # stable lineage id, minted by `lunaris init`
name = "your-repo"

[models]
default = "anthropic/claude-sonnet-4-6"   # "<provider>/<model>"
[models.roles]                            # optional per-role overrides
coder = "anthropic/claude-sonnet-4-6"
reviewer = "deepseek/deepseek-chat"
researcher = "ollama/qwen3:8b"

[providers.anthropic]
keyEnv = "ANTHROPIC_API_KEY"
[providers.deepseek]
baseUrl = "https://api.deepseek.com"
keyEnv = "DEEPSEEK_API_KEY"
[providers.openai]
keyEnv = "OPENAI_API_KEY"
[providers.ollama]
baseUrl = "http://localhost:11434"        # local, no key

[budgets]
perCallUsd = 0.5
perDayUsd  = 10.0                          # enforced transactionally by the gateway
```

**Providers:** Anthropic, OpenAI, DeepSeek and any OpenAI-compatible endpoint (via `baseUrl`), Ollama (local), plus `mock/echo` for offline runs. Budgets are reserved at call admission and settled on completion — concurrent subagents can't collectively overshoot a cap.

**API keys — `.aienv` (per project, preferred):** copy `.aienv.sample` → `.aienv` and fill in the key names your providers reference. The harness loads it per project and merges into the environment without overwriting existing exports. `.aienv` is gitignored. Shell `export` and CI-injected env vars also work and take precedence.

### Autonomy policy — `.lunaris/policy.yaml` (optional)

Controls what agents may do without asking. Four levels: `0` read-only · `1` supervised · `2` autonomous-in-workspace (default) · `3` full-auto. Rules are `allow` / `deny` / `queue`; irreversible actions (git push, deploy, publish, `rm -rf` outside the repo) always queue for approval regardless of level, and untrusted (tainted) content tightens the profile automatically.

```yaml
level: 2
tightenWhenTainted: true
allowlistedHosts: ["api.github.com"]
rules:
  - effect: deny
    tools: [run_bash]
    commands: ["curl * | sh"]
```

Resolve queued actions with `lunaris approvals` or the UI approval inbox.

### Environment variables

| Var | Purpose | Default |
|---|---|---|
| `LUNARISD_PORT` | daemon port | `7340` |
| `LUNARIS_AUTH` | `on` enables auth/RBAC on the daemon API | `off` (loopback single-owner) |
| `LUNARIS_WEBHOOK_SECRET` | HMAC secret for `/hooks/:project/:source` | — (loopback-only without it) |
| `LUNARIS_WEBHOOK_SECRET_<PROJECTID>` | per-project webhook secret override | — |
| `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` | provider keys (names are whatever `keyEnv` says); set via `.aienv` or shell export | — |

---

## CLI reference (`lunaris …`)

**Core** — `init [--name]` · `chat <prompt…> [--model]` · `status` · `events [--tail n]` · `daemon [--port]`

**Memory & analytics** — `memory [--search q] [--limit n]` · `analytics [--since iso]`

**Autonomy** — `approvals [--resolve <id> --approve|--deny]`

**Optimizer** — `optimize [--since iso]` · `proposals [--resolve <id> --approve|--reject] [--status]`

**Plugins** — `plugins` · `plugin new <dir> [--id --name]` · `plugin enable|disable <id>`

**Scheduler** — `schedule [list | add --cron <expr> --prompt <p> | rm <id>]` · `queue [list | push <prompt…> --priority n]`

**Identity & lifecycle** — `login [--user --password]` · `whoami` · `lease` · `version` · `snapshot [list|create]` · `restore <id> [--dry-run]` · `export [--out path]` · `adopt`

Run `lunaris <command> --help` for options.

---

## HTTP API (daemon, 127.0.0.1:7340)

Read-only/status: `GET /api/status` · `GET /api/version` · `GET /api/whoami` · `GET /api/projects`

Per project (`/api/projects/:id/…`): `POST goals` · `GET events` · `GET memory` · `GET memory/graph` · `GET analytics` · `GET/PUT policy` · `GET approvals` · `POST optimize` · `GET proposals` · `GET/POST queue` · `GET/POST/DELETE schedules` · `GET/POST triggers` · `GET/POST plugins` (+ `plugins/:pluginId/enable|disable`) · `POST snapshot` · `GET snapshots` · `POST restore` · `POST export`

Resolve queues: `POST /api/approvals/:ticketId/resolve` · `POST /api/proposals/:proposalId/resolve`

Auth (when `LUNARIS_AUTH=on`): `POST /api/login` → bearer token; `POST /api/ws-ticket` → short-lived single-use WS ticket. Live events: `WS /api/ws` (auth via `?ticket=` short ticket, never the bearer token). Webhook intake: `POST /hooks/:projectId/:source` (HMAC-verified).

The daemon binds `127.0.0.1` only and refuses any non-loopback host. With `LUNARIS_AUTH=off` (default) a single implicit loopback owner is allowed everything — the zero-config single-user path. Remote access is intended via SSH/Tailscale tunnel.

---

## Project layout under `.lunaris/`

```
lunaris.toml                 # committed manifest
.aienv.sample                # committed template for provider keys
.aienv                        # gitignored — your actual keys (copy of the sample)
.lunaris/
  state/                     # events.db, memory state, instance.json (machine-local id), queues
  memory/graph.db            # knowledge-graph memory
  journal/<goalId>.jsonl     # per-run transcript journal
  policy.yaml                # optional autonomy policy
  plugins/                   # installed plugins (plugin.toml each)
  snapshots/                 # snapshot archives
```
`~/.lunaris/` holds machine-global state: project registry, identity/leases dbs, the agent-token signing key, node id.

---

## Packages

| Package | Responsibility |
|---|---|
| `@lunaris/core` | Shared contracts, `lunaris.toml` manifest (zod), UUIDv7 ids, SQLite event store, analytics, schema migration + version + doctor |
| `@lunaris/gateway` | Multi-provider model gateway (Anthropic, OpenAI-compatible, Ollama, mock), streaming/tool-call/vision normalization, transactional budget ledger |
| `@lunaris/orchestrator` | Agent loop: roles, confined tools (read/write/list/bash/web_fetch), subagent spawn + token attenuation, lease fencing, JSONL journal |
| `@lunaris/memory` | Graphified memory: selective-retention gate, lexical/embedding similarity, community clustering, decay/prune, advisory briefs |
| `@lunaris/policy` | PDP: rule engine (allow/deny/queue), autonomy levels, irreversible-action class, taint tracker, SQLite approval queue |
| `@lunaris/optimizer` | Recursive self-optimizer: outcome ledger, Wilson success stats, routing bandit, propose-only config proposals |
| `@lunaris/plugd` | Plugin host: `plugin.toml` manifests, contributed tools + MCP server defs, enable/disable registry, scaffold |
| `@lunaris/scheduler` | Goal queue, cron parser, schedules, trigger rules, HMAC webhook routing, dispatcher |
| `@lunaris/identity` | Control plane: principals, scrypt auth + sessions, RBAC role→capability matrix, Ed25519 attenuable capability tokens, lease store with epoch fencing |
| `@lunaris/lifecycle` | Snapshot/restore, export/import bundle, two-level project identity (committed lineage + machine-local instance), `adopt` |
| `@lunaris/daemon` | `lunarisd`: HTTP+WS API, project registry, async goal runner, scheduler tick loop |
| `@lunaris/cli` | The `lunaris` command |
| `@lunaris/ui` | Mission Control: chat + live feed + analytics / memory-graph / approvals / optimize / plugins / automation / system panels (Vite + React) |

---

## Multi-machine / clone

State under `.lunaris/state` and `.lunaris/memory` is gitignored. After cloning a repo that has a committed `lunaris.toml`:

```sh
lunaris adopt    # mints a fresh machine-local instance id, recreates state dirs
```

`lunaris export` produces a portable bundle (memory + proposals + analytics, secrets excluded); importing it elsewhere always mints a fresh instance id so secret namespaces never collide.

---

## Roadmap

Spec §17: ~~Phase 1 MVP~~ · ~~Phase 2 memory/policy/analytics~~ · ~~Phase 3 optimizer/plugins/scheduler~~ · ~~Phase 4 identity/leases/lifecycle~~ — **all done.**

Deferred past v1 (noted in spec): optimizer golden-eval A/B harness, plugin UI panels + sandboxing, lifecycle state-sync/merge/team-memory, external control-plane (Postgres) fleet mode, harness self-update binary slots.
