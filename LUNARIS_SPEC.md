# Lunaris — Product & Architecture Specification

**Status:** Draft v1 · **Date:** 2026-06-11 · **Owner:** Sahir Nagpal

Lunaris is a local-first, autonomous, multi-project AI development harness. Every repository gets its own hermetic AI virtualenv (skills, MCP servers, plugins, tools, models, memory — declared in a committed manifest, pinned by a lockfile). A persistent per-project orchestrator decomposes goals into task DAGs and executes them unattended via specialized subagents, consulting a per-project knowledge-graph memory that acts as an advisory guide, never an oracle. All LLM traffic flows through one multi-provider gateway (Anthropic, OpenAI, DeepSeek, Gemini, Ollama, OpenRouter, any OpenAI-compatible endpoint); every action lands on one append-only event spine that powers live observability, analytics, and a recursive self-optimizer that rewrites routing, prompts, and memory parameters under guardrails it structurally cannot touch. A Mission Control web UI is the single pane of glass: chat with each orchestrator, watch every subagent live, browse the memory graph, manage the environment, clear an async approval inbox, and audit everything.

---

## 1. Core Principles

1. **Autonomy without consent prompts, with guardrails.** Agents are never blocked mid-task on a human. Policy is declarative; the decision point returns ALLOW / DENY / QUEUE / TRANSFORM — compiled allow/deny rules decide common operations in sub-millisecond time, the shell-AST analysis path takes low milliseconds, and the LLM intent classifier is reserved for ambiguous high-risk operations: it may take seconds and never blocks low-risk work. Denials are machine-readable steering, not dead ends. Only irreversible actions queue for asynchronous human approval. Sandboxes, git checkpoints, and budgets — not dialogs — are what make "no prompts" safe.
2. **Memory is advisory, not oracle.** Every injected memory carries confidence, provenance, and staleness markers. Agents must verify before trusting (tiered: existence check → read → execute) and must report feedback after use. Destructive actions can never be justified by memory alone.
3. **Everything observable.** Every LLM call, tool invocation, agent spawn, memory operation, config change, and human action is one event on one append-only spine, with full trace lineage (run → task → span). Failure forensics rest on full-fidelity transcript capture — every LLM request/response and tool args/results stored — supporting forensic inspection and recorded-response simulation; re-execution against live providers is a new experiment, not deterministic replay.
4. **Everything optimizable.** Routing tables, role prompts, memory parameters, and decomposition templates are versioned, machine-editable artifacts. The optimizer proposes diffs, evaluates them against golden tasks, canaries them, and auto-rolls back regressions. Loosening safety always requires a human; tightening may auto-apply.
5. **Per-project isolation.** One project = one manifest, one lockfile, one memory graph, one orchestrator, one keychain namespace, one event stream. Nothing leaks between projects; global sharing (memory tier, learnings) is explicit and opt-in.
6. **Local-first, cloud-optional.** Single machine, zero external infrastructure by default: SQLite, DuckDB, JSONL, unix sockets, OS keychain. Cloud sync, fleet mode, and multi-user are additive layers, not prerequisites. Ollama is a first-class provider. All state and UI are local; degraded operation without network is best-effort per the failure-mode matrix (§6), not a guarantee.
7. **One authority per concern.** Exactly one file owns routing, one owns budgets, one owns policy, one daemon supervises everything, one library parses config, one service writes it. Conformance is mechanically enforced (`lun doctor`), not aspirational.

---

## 2. System Architecture Overview (Harness Core)

This section is binding on every subsystem below. No subsystem invents its own files, daemons, or stores; all state flows through the canonical layout, the `lunaris-config` library, and `lunarisd` APIs.

### 2.1 Process topology

Exactly one user-level daemon: **`lunarisd`** (launchd/systemd unit, or auto-spawned on demand by CLI/UI).

```
lunarisd  (one per user)
├── in-process modules:
│   ConfigD          — sole config writer, journal, rollback
│   SecretBroker     — sole secret system, keychain-backed
│   EventBus         — append-only event spine + DuckDB index
│   ModelGateway     — all LLM/embedding traffic
│   TaxonomyRegistry — compiled task_class vocabulary
│   PDP              — policy decision point (autonomy/safety)
│   Scheduler        — goal queue, cron, triggers, watchdog
│   ProjectSupervisor
└── project-host  (one child process per ACTIVE project; lazy start, idle TTL shutdown)
    ├── Orchestrator runtime (+ subagent runners)
    ├── Memory Service       (exclusive handle on memory/graph.db)
    └── supervised MCP server child processes (from lockfile)
```

- **One daemon per machine:** exactly one `lunarisd`. The control plane (identity, RBAC, leases, vault) is an embedded module by default; fleet mode (§15) externalizes that module to a standalone `lunaris-control` service — it never adds a second per-machine daemon.
- **Control plane:** JSON-RPC 2.0 over unix socket `~/.lunaris/run/lunarisd.sock`. Versioned method namespaces: `config.*`, `secret.*`, `events.subscribe/publish`, `route.resolve`, `budget.check`, `project.*`, `memory.*` (proxied to project-host), `queue.*`, `schedule.*`.
- **Data plane:** per-project stream socket `~/.lunaris/run/projects/<id>.sock` for high-volume event/chat/token streams; the UI's WebSocket bridge tails it.
- **Crash-only design:** event segments are fsync'd on flush; config is atomic + journaled; SQLite stores run WAL mode. A project-host crash or machine reboot loses at most seconds; completed work is not re-executed on resume (replanning may still mark done nodes stale later, §5).
- `lun daemon status` prints the supervision tree with PIDs, restart counts, and socket health.

### 2.2 Canonical state layout (layout_version = 1)

**Per repo** (committed unless marked gitignored):

```
<repo>/.lunaris/
  lunaris.toml              # THE manifest (human lane). [project] [capabilities] [providers] [memory] [devenv] [taxonomy] [workspace?]
  lunaris.local.toml        # gitignored per-developer manifest overrides (human lane; layered resolution, §3)
  lock/lunaris.lock       # resolved pins (system lane): {skills,mcp,plugins,tools}[] each {name, version, sha256, declared_secrets[]}
  config/
    routing.yaml            # THE routing authority (optimizer lane)
    budgets.yaml            # THE budget authority (human lane)
    policy.yaml             # autonomy/permission policy (human lane)
    policy.local.yaml       # gitignored per-developer policy overrides
    taxonomy.yaml           # project task_class extensions, namespace x.<project>.* only
    .journal/               # content-addressed config history: <rev>.json {rev, parent_rev, file, actor, lane, reason, patch, canary}
  automation/
    schedules.yaml          # recurring goals (human lane)
    triggers.yaml           # event→goal rules (human lane)
    templates/*.yaml        # parameterized goal templates
  roles/*.role.yaml         # subagent role definitions (built-in overrides + user roles)
  templates/*.plan.yaml     # reusable decomposition templates
  evals/golden/             # golden task suite (committable)
  capabilities/{skills,mcp,plugins,tools}/   # installed payloads (system lane)
  memory/
    graph.db                # gitignored; SQLite WAL; sole writer = Memory Service
    export/*.jsonl          # committable deterministic KG export (entities, relations) — doubles as seed state
  generated/                # optimizer lane: tuned prompts, retrieval params, learned guidance (gitignored)
  state/                    # gitignored runtime
    board.db                # task board (goals, tasks, leases, messages, artifacts, verdicts)
    runs/<run_id>/          # session journals + checkpoints (<seq>.ckpt)
    transcripts/<agent>.jsonl
    artifacts/<sha256>      # content-addressed task artifacts
    backups/<store>/<ts>-v<from>-to-v<to>.db.zst
    instance.json           # per-checkout instance identity (gitignored)
    cache/                  # LLM response cache, misc
    lock                    # advisory flock
  worktrees/<task_id>/      # git worktree per code-mutating task
  .gitignore                # generated; pins the commit/ignore split above
```

**Per user:**

```
~/.lunaris/
  config/{routing.yaml,budgets.yaml,policy.yaml}   # machine defaults, lowest precedence; budgets merge by MIN
  global.toml               # user-global manifest defaults (human lane; layered resolution, §3)
  projects.toml             # project_id -> {paths[], display_name, last_opened, status}
  projects/<project_id>/
    events/seg-<tshour>.jsonl   # THE durable event log (append-only, hourly segments, zstd after rotation)
    events.duckdb               # derived index + materialized views (rebuildable from segments)
    blobs/<sha256[0:2]>/<sha256>.zst   # content-addressed payloads (prompts, responses, tool I/O)
    automation.db               # goal queue / schedule runtime state
  global-memory/            # opt-in cross-project memory tier (read-only mount into projects)
  store/sha256/<hash>/      # content-addressed capability/snapshot store (pnpm-style) + store-refs.db
  profiles/<name>@<ver>/    # cached env profiles
  models.yaml               # model capability catalog (shipped + remote refresh)
  versions/<semver>/        # A/B binary slots; `current` symlink
  trash/<project_id>/       # tombstoned project bundles (30d TTL)
  contexts.toml             # remote daemon contexts (kubeconfig-style; tokens in keychain)
  secrets.age               # headless fallback only; primary store = OS keychain
  run/lunarisd.sock  run/projects/<id>.sock
<install>/taxonomy/core.yaml   # shipped task taxonomy
<install>/schemas/             # JSON Schemas for every file, versioned with layout
```

**Deprecation rule:** legacy roots (`.aienv/`, `.ai/`, ad-hoc `.aiharness` variants) are detected read-only and produce a hard error pointing at `lun migrate` — no silent dual-read, no split-brain.

### 2.3 lunaris.toml — the single manifest

The one human-edited entry point. Sections:

- `[project]` — `project_id` (stable ULID minted at `lun init`, committed; names the project lineage), `name`, `layout_version`.
- `[capabilities]` — declared skills/MCP/plugins/tools with semver ranges and sources (registry/git/path); resolved pins live in `lock/lunaris.lock`.
- `[providers]` — provider declarations by alias: `{type: anthropic|openai|deepseek|gemini|ollama|openrouter|openai-compatible, base_url?, api_key: "secret://<scope>/<key>"}`. Raw keys never appear inline.
- `[memory]` — curation/decay knobs (half-lives, gate weights, max nodes, global-tier on/off, `trust = "advisory"`).
- `[devenv]` — execution-environment provisioner (§3 devenv).
- `[taxonomy]`, `[workspace]` (monorepo members), `[lifecycle]` (backup/sharing config).

**Schema-rejected keys:** routing rules, budgets, and autonomy policy are NOT allowed in `lunaris.toml` — the schema rejects them so the single-authority rule cannot erode.

### 2.4 Authority matrix — one file per concern, one writer lane

| Concern | Sole authority | Writer lane | Readers |
|---|---|---|---|
| Manifest / providers / capabilities | `.lunaris/lunaris.toml` (+ gitignored `lunaris.local.toml` per-dev overrides, `~/.lunaris/global.toml` user-global defaults) | HUMAN | everything via lunaris-config |
| Routing policy | `.lunaris/config/routing.yaml` | OPTIMIZER (via ConfigD) | ModelGateway, Orchestrator, Optimizer |
| Budgets | `.lunaris/config/budgets.yaml` | HUMAN | ModelGateway (sole enforcement point), UI |
| Autonomy / permissions | `.lunaris/config/policy.yaml` | HUMAN | PDP, SecretBroker, Orchestrator |
| Secrets | SecretBroker (OS keychain / `secrets.age`) | SecretBroker | leaseholders only |
| Events / telemetry / audit | `~/.lunaris/projects/<id>/events/` + `events.duckdb` | EventBus | Analytics, Optimizer, UI |
| Memory | `.lunaris/memory/graph.db` | Memory Service (exclusive) | all via `memory.*` RPC |
| Taxonomy | compiled `core.yaml` + `config/taxonomy.yaml` | HUMAN | routing validation, events, analytics |
| Lockfile / installed payloads / state | `lock/`, `capabilities/`, `state/` | SYSTEM | all |
| Tuned prompts / retrieval params | `.lunaris/generated/` | OPTIMIZER (via ConfigD) | Orchestrator, Memory Service |

Three writer lanes are enforced by ConfigD per file. Cross-lane writes return `LANE_VIOLATION` (e.g. the optimizer attempting to raise a budget). The optimizer may only file *proposals* against human-lane files; these surface in the UI approval queue.

### 2.5 ConfigD — the single config write service

All writes to `lunaris.toml` and `config/*` go through ConfigD via one API:

```
ProposeChange(file, json-patch, actor, reason)
  → Validate (schema + cross-file invariants: routing aliases ∈ lunaris.toml providers;
              task_class globs compile against taxonomy; no foreign-concern keys)
  → Commit (atomic temp+rename, fsync)
  → Journal (.lunaris/config/.journal/<rev>.json) → broadcast config-changed event
```

- `lun config get/set/unset <dotted.key>` (routes to the correct file by key namespace), `lun config diff`, `lun config history <file>`, `lun config rollback <file> --to <rev>`, `lun config effective [file] --explain` (merged result with per-key provenance).
- ConfigD watches files (fsnotify) for out-of-band human edits, validates, journals them as `actor=human:direct-edit`, and broadcasts so the gateway/orchestrator/memory hot-reload from one source. An invalid direct edit never becomes live: ConfigD keeps the last-good generation active, quarantines the bad content, and emits a `config.invalid` event (UI/CLI alert); all readers continue serving the last-good generation until the file validates again.
- **Optimizer pipeline (the only autonomous write path):** Propose → Validate → Canary (journal rev marked `canary=true`; gateway routes a configurable fraction of matching tasks via the canary rev; events tagged with `config_rev`) → Promote or auto-rollback to `parent_rev` after the evaluation window.

### 2.6 SecretBroker

One broker module in lunarisd. Backing store: OS keychain (macOS Keychain, Windows DPAPI, libsecret) via a keyring abstraction; headless fallback: one age-encrypted file `~/.lunaris/secrets.age` unlocked at daemon start. Secrets are addressed by URI (`secret://<scope>/<key>`) from `lunaris.toml` and capability manifests; plaintext never appears in repo files, the config journal, the event log, or subagent environments by default. Secret namespaces are keyed by the machine-local `instance_id` (§14 two-level identity), never the committed lineage `project_id`: a cloned or templated repo keeps `project_id` lineage but mints a fresh `instance_id`, so it can never collide with another project's keychain namespace.

- Components request **short-lived leases** over the lunarisd socket; ACLs derive from the capability lockfile (an MCP server gets only the secrets its manifest declares; subagents get none unless `policy.yaml` grants them).
- Delivery modes (escalating): env-injection scoped to one allowlisted command; **broker-proxy** (broker attaches the credential host-side — the raw token never enters sandbox or model context); ephemeral minted credentials (GitHub fine-grained tokens, AWS STS) where supported.
- A redaction layer scrubs known secret values + high-entropy strings from all tool output before it reaches model context, transcripts, or logs.
- Every grant/denial emits `secret.lease.granted/denied` to the spine. CLI: `lun secret set|list|rm|test`. The UI settings page is a thin client of the same RPC.

### 2.7 Event spine

One pipeline replaces all per-subsystem telemetry stores. Every producer (orchestrator, subagents, ModelGateway, Memory Service, Optimizer, ConfigD, SecretBroker, PDP, Scheduler, UI actions) emits one envelope over the lunarisd socket:

```
{event_id: ULID, ts, monotonic_ns, project_id, run_id, task_id,
 trace_id, span_id, parent_span_id, agent_id, agent_role,
 event_type,            # namespaced: task.*, llm.call, llm.usage, tool.invoked, memory.*,
                        # config.committed, secret.lease.*, optimizer.proposal.*, budget.*,
                        # policy.decision, approval.*, schedule.fired, plugin.*, user.intervention
 task_class,            # validated against compiled taxonomy; unknown → 'unknown' + lint event
 config_rev?, provider?, model?, tokens_in?, tokens_out?, cached_in?, cost_usd?,
 duration_ms?, outcome?,  # success|failure|partial|cancelled|denied|orphaned
 principal_id?, payload}
```

- EventBus appends to hourly-rotated JSONL segments (`seg-<ts>.jsonl`, zstd after rotation — the durable, greppable, rsyncable source of truth) and asynchronously maintains a DuckDB index with materialized views: `spend_by_task_class`, `success_rate_by_route`, `latency_p95`, `memory_hit_rate`, model/agent/tool scorecards.
- **BudgetLedger** is a transactional ledger inside the ModelGateway (single enforcement point): atomic `reserve(estimated_cost)` at call admission against `budgets.yaml` caps (the reservation counts immediately), `settle(actual_cost)` on completion, refund on failure — concurrent subagents cannot collectively overshoot a cap. The DuckDB spend view over `llm.usage` events is reporting-only, never enforcement.
- Control/audit actions (approvals, kills, policy edits, secret ops) are hash-chained events with daily Merkle-root checkpoints (`~/.lunaris/audit/roots.log`) for tamper evidence.
- Hard rule enforced by `lun doctor`: no other DB file may store telemetry. Analytics and the Optimizer query DuckDB only.

### 2.8 Task taxonomy registry

One owned `task_class` vocabulary that routing, events, analytics, and the optimizer all join on. Core ships at `<install>/taxonomy/core.yaml` (versioned): hierarchical dotted ids — `code.generate`, `code.edit`, `code.review`, `code.refactor`, `test.write`, `test.run`, `debug.investigate`, `debug.fix`, `research.web`, `research.codebase`, `plan.decompose`, `docs.write`, `ops.build`, `ops.deploy`, `memory.curate`, `memory.retrieve`, `orchestrate.route`, `orchestrate.review` — each with `{description, default_complexity_tier (1-4), latency_class (interactive|batch), verifiable (bool)}`. Projects extend under `x.<project>.*` only (shadowing core ids fails validation). lunarisd compiles core + extension into one frozen lookup. Routing rules validate at commit time; version bumps ship remap tables (`lun migrate --taxonomy`) so historical analytics stay joinable.

### 2.9 lunaris-config library and precedence

One library (single core implementation + bindings per runtime language) is the ONLY code allowed to read/merge harness state: typed accessors for every file, the precedence merge, `secret://` resolution into broker handles, and a `watch()` API fed by ConfigD broadcasts. JSON Schemas (draft 2020-12) for every file live in one versioned `schemas/` package; the library refuses files newer than it understands with a clear upgrade message.

**Precedence (implemented once):** machine `~/.lunaris/config/*` < project `.lunaris/config/*` < ephemeral run-scoped overrides (CLI `--set`, UI "just this run" toggles — held in memory, journaled as `run.override` events, never persisted). Scalars replace; rule-lists concatenate with project priority winning; **budgets merge by MIN** (a project can tighten but never loosen the machine cap).

### 2.10 Conformance and migration

- **`lun doctor [--strict] [--fix]`** — mechanical enforcement, runnable in CI: exactly one per-repo root and no legacy dirs; schema/layout versions compatible; no foreign-concern keys in any config file; `secret://` URIs resolve and no plaintext-key patterns in tracked files; single daemon on the canonical socket, no orphan legacy daemons; no stray `*.db` outside sanctioned paths; taxonomy compiles; journal head matches on-disk hashes (detects unjournaled edits); lockfile consistent with `capabilities/`.
- **`lun migrate [--dry-run] [--finalize]`** — one-shot idempotent consolidation of any legacy layouts: merged-config diff with per-key source annotations and conflict prompts, memory DB moved with integrity check, legacy telemetry replayed into the spine with `migrated=true`, secrets imported into SecretBroker then shredded, legacy roots renamed to `.lunaris/migration-backup/<ts>/`.
- **Multi-client safety:** advisory flock on `.lunaris/state/lock` held by project-host; ConfigD serializes commits per project; a second lunarisd refuses to start if the socket is live; a foreign-host lock (synced folder) triggers read-only mode, not corruption.

---

## 3. Per-Repo AI Virtualenv ("aienv")

### Overview

Every repository gets a hermetic AI environment — skills, MCP servers, plugins, tools, providers, memory config — declared in `lunaris.toml`, pinned byte-for-byte by `lock/lunaris.lock`, and materialized into an isolated runtime cell per project. Semantics mirror pip/npm: manifest = intent (semver ranges), lockfile = exact reproducible pins, content-addressed global store = shared artifacts without shared state. Layered resolution lets projects override user-global defaults; hard isolation guarantees (namespaced secrets, per-project MCP processes, per-project memory DB) mean nothing leaks between projects. The former standalone `aienvd` is dissolved: its duties live in lunarisd's ProjectSupervisor, and the CLI is `lun`.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Workspace manifest (`lunaris.toml`) | core | Single committed manifest (§2.3). Capability entries carry version specs and sources (registry / git / path). Validated against a published JSON Schema; `lun validate` + editor LSP support. |
| Lockfile with deterministic installs | core | `lock/lunaris.lock` pins every capability to exact version + sha256 + resolved source URL (+ OCI image digest for containerized MCP servers), full transitive graph, granted permission scopes, and `manifest_hash` for drift detection. Manifests may reference mutable refs (e.g. a git branch), but the lockfile always resolves them to an exact commit SHA + content hash at lock time. `lun install` reproduces the env on any machine; `lun update [name]` re-resolves within ranges. Drift marks the env *dirty* in CLI, UI, and orchestrator preflight. |
| Capability manager CLI | core | `lun skill add\|remove\|list\|enable\|disable\|update\|info\|pin`; `lun mcp add\|remove\|list\|enable\|disable\|auth\|test\|logs`; `lun plugin …`; `lun tool allow\|deny\|list`; `lun model list\|pin`. Env verbs: `lun init [--profile X]`, `lun install`, `lun update`, `lun freeze`, `lun diff`, `lun doctor`. All mutations edit the manifest, re-resolve, rewrite the lock, emit `env.updated` — the CLI is the lockfile's only writer. |
| Daemon API | core | Same operations over the lunarisd socket: `env.resolve`, `env.snapshot(generation?)`, `<type>.list/add/…`, `mcp.start/stop/status`, plus an `env.updated` / `capability.state` subscription stream. CLI and daemon share one resolver library so behavior never diverges. |
| Layered resolution | core | Highest wins per capability name: (1) ephemeral session overrides → (2) `.lunaris/lunaris.local.toml` (gitignored per-developer) → (3) project `lunaris.toml` → (4) extended profiles in declaration order → (5) user-global `~/.lunaris/global.toml` → (6) builtins. `enabled=false` masks lower layers. Inheritance is opt-in per type: `inherit.mcp = "none"` by default (global MCP servers and creds never auto-appear in a project); `inherit.skills = "explicit"`. `lun resolve --explain <name>` prints which layer won. |
| Project isolation cells | core | Keyed by `project_id`: MCP servers spawn per-project with a scrubbed environment containing only declared vars; secrets live under keychain namespace `lunaris/<instance_id>/<key>` (machine-local instance identity, §14 — never the committed lineage id); per-project memory DB; FS tool scope defaults to repo root + declared `extra_paths`; per-MCP-server network allowlists. Optional hardened mode runs MCP servers in OCI containers pinned by lockfile digest. |
| Profiles / templates | important | A profile = versioned partial manifest + scaffold hooks (e.g. `python-api@1.2.0`: pytest-runner skill, postgres MCP, ruff/mypy tool policy, routing seeds). `lun init --profile python-api` merges it and records `extends = ["python-api@1.2.0"]`. Profiles compose later-wins; orgs can publish their own. |
| Capability registry | important | HTTP service (or plain git/OCI registry for small teams) hosting versioned packages of four kinds: skill, mcp-server-def, plugin, profile. Package = tarball with `capability.toml` (name, semver, type, requested permissions, compatible harness range, deps) + payload. `lun publish` pushes; private registries with token auth; offline mirror cache. Signature verification (minisign/sigstore) is ON by default — per-registry opt-out requires an explicit `unsigned = true` and pins a standing warning in the UI and `lun doctor`. Managers poll registry revocation lists; a revoked package is disabled across all projects and surfaced as an alert. |
| Content-addressed store | important | Artifacts stored once per machine in `~/.lunaris/store/sha256/<hash>/`, linked read-only into `.lunaris/capabilities/`. Ten projects share one immutable copy but keep separate runtime state and credentials. `lun gc` prunes unreferenced entries (refcounts in `store-refs.db`, §14). |
| Hot reload with generational snapshots | important | Watcher on manifest/lock: parse → validate → diff → minimal change plan (stop/start MCP servers, reload skill index, swap routing table) → apply → broadcast `env.updated`. Environments are immutable generation-numbered snapshots: in-flight tasks keep the generation they started with; new tasks bind the latest. Invalid edits are rejected with diagnostics; the last good generation stays live. |
| Permission manifests + audit | important | Every package's `capability.toml` declares requested permissions (fs paths, network hosts, secrets, shell). Install shows the grant diff once (no per-action prompts at runtime); grants are recorded in the lockfile; `lun audit` lists every effective permission. Out-of-scope calls are denied and logged, never escalated mid-task. |
| Env health checks | important | `lun doctor` (env slice): schema, manifest/lock drift, MCP ping (spawn + initialize + tool listing), secret refs resolve, provider keys valid, store hashes verified, memory DB integrity. Run as orchestrator session preflight; UI shows one-click fixes. |
| Freeze / export / diff | nice-to-have | `lun freeze` emits a fully-pinned flattened manifest; `lun env export --bundle env.tar` for air-gapped machines; `lun diff <git-ref>` shows capability-level changes between commits (PR review: "this PR adds a postgres MCP server with network access to prod-db"). |
| Container-grade MCP isolation | nice-to-have | Per-server `isolation = "process" \| "container"`; container mode = OCI run pinned by lock digest with explicit mounts + network allowlist — recommended default for third-party registry MCP servers handling credentials. |

### Architecture notes

- **Resolution algorithm:** load layers → apply per-type inherit gates → merge per capability name (higher layer wins whole-entry; deep-merge only for `[memory]` scalars) → pin via lockfile (PubGrub-style semver solving on update) → emit immutable `EnvSnapshot {generation, capabilities[], memory_config, permission_grants}` served over the daemon API.
- **MCP spawn:** clean env (no inherited shell env), manifest-declared vars only, `secret://` refs resolved in-memory at spawn; stdio transport multiplexed by project-host; secret-redaction middleware on all logs/transcripts.
- **Model declaration vs routing:** `lunaris.toml [providers]` declares providers and available models; all *routing* (role/task-class → model rules, fallbacks) lives exclusively in `config/routing.yaml` (§2.4). The legacy `[models]`-section routing from earlier drafts is deleted.

### Integration points

- **Orchestrator:** calls `env.snapshot` at session start for the immutable capability set and permission grants; pins each subagent task to a snapshot generation; subscribes to `env.updated` for new tasks only.
- **Memory:** `lunaris.toml [memory]` is the single source of per-project memory configuration; the graph DB lives inside the cell at `.lunaris/memory/graph.db`.
- **Optimizer:** every tool/skill/MCP invocation is event-tagged `name@version` from the lock, so analytics aggregate per capability; the optimizer proposes manifest edits (disable unused MCP servers, etc.) as human-lane proposals.
- **CI:** `lun install && lun doctor --strict` reproduces and validates the env headlessly; manifest + lock are committed and reviewable.

### Dev-environment provisioning ("devenv") — core

The harness OWNS reproducible per-project execution environments instead of assuming them — the most common real-world failure mode of unattended coding agents is the first `npm test` dying in an unprovisioned sandbox.

- `lunaris.toml [devenv]` declares a provisioner: `devcontainer` (reuse an existing devcontainer.json), `nix` (flake), `dockerfile`, or `probe` (fallback: detects language, package manager, and test runner, synthesizes a best-effort environment). Service dependencies (Postgres/Redis/compose), seed data, and warm-up commands are declared alongside.
- CLI: `lun devenv build|verify|shell`. `verify` runs the declared health command inside the built environment; orchestrator session preflight and `lun doctor` include it.
- Environments are content-hashed (provisioner inputs + lockfile) and cached in the global store; many worktrees share one immutable image with per-task overlay state.
- Consumers: subagent sandboxes (§6) launch inside the devenv image; the integrator's full-test step (§5) and the golden-eval runner (§9) use the identical environment, so eval results transfer to live tasks.
- Provisioning failures are tagged `failure_class = infra/environment` (§5) so they never poison optimizer model- or prompt-quality statistics; the orchestrator inserts a DEVOPS fix-env task instead of retrying the model.

Basic devenv (reuse an existing devcontainer + probe fallback) lands in Phase 1; full provisioners in Phase 2 (§17).

---

## 4. Graphified Memory

### Overview

Each project owns an isolated GraphRAG-style memory: a knowledge graph of entities and typed relations clustered into hierarchical communities (Leiden) with LLM-written summaries, plus typed memory records (episodic / semantic / procedural) attached to graph nodes. A Memory Service (inside project-host, exclusive owner of `.lunaris/memory/graph.db`) ingests conversations, code, docs, and task outcomes through an extract → gate → merge → recluster → resummarize pipeline. Retrieval runs in local (entity-hop) or global (community map-reduce) mode and is injected into agents as an explicitly advisory "memory brief". Retention is selective: candidates are scored before commit, reinforced when useful, decayed on half-lives, adjudicated when contradicted, pruned when stale. The format is wire-compatible with the user's existing `/graphify` skill (same EXTRACTED/INFERRED/AMBIGUOUS confidence taxonomy, `graph.json` export).

### Features

| Feature | Priority | Notes |
|---|---|---|
| Ingestion pipeline | core | Sources: transcripts (chunked per task), code (deterministic AST extraction for symbols/imports/calls — free; cheap-LLM pass for semantic edges), docs/ADRs, and structured TaskResult events. A cheap model emits candidate entities/relations/records; every relation carries `confidence_tag` EXTRACTED (1.0) / INFERRED (0.4–0.9) / AMBIGUOUS (0.1–0.3). Merge: entity resolution by exact id → alias table → embedding cosine > 0.92 with LLM tie-break; duplicate relations increment weight. Incremental Leiden after merge batches; full re-cluster when >20% of nodes changed; dirty community summaries regenerated (≤300 tokens + key_claims). |
| Selective retention gate | core | Nothing enters unscored: novelty, utility, generality, durability, provenance-confidence → weighted composite. Commit ≥ 0.55; quarantine 0.40–0.55 (kept 7 days, promoted only if retrieved and marked helpful); discard < 0.40 (counted). Hard rules: secrets never committed (regex + entropy scan); raw transcripts never stored — only distilled records ≤ 200 tokens with provenance pointers. Humans set allowed bounds (gate thresholds, weight ranges) in `lunaris.toml [memory]`; the optimizer writes concrete values within those bounds to `.lunaris/generated/memory-params.yaml` — effective config = generated values clamped to the human bounds. |
| Three memory types | core | EPISODIC (one record per task: goal, approach, outcome, errors, cost; half-life 14d), SEMANTIC (facts, conventions, decisions as entity-relation claims; 90d), PROCEDURAL (ordered step recipes keyed to task_type; 45d; auto-candidate whenever an agent succeeds where a prior attempt failed). Each renders differently in briefs and decays on its own schedule. |
| Local retrieval | core | Embed + lexically link query → top-3 seed entities → weighted k-hop expansion (k=2) ranked by personalized PageRank, edge traversal cost ∝ (1 − confidence) so AMBIGUOUS edges are visited last → attach records ranked by strength × type-match × recency → pack into caller token budget (default 1,200) with provenance + staleness per item. |
| Global retrieval | core | Rank community summaries by embedding similarity at the requested hierarchy level → MAP: cheap LLM scores top-N communities and extracts partial answers with citations → REDUCE: merge into one answer citing community + record ids. Cost-bounded; map calls on the cheapest provider. |
| Auto routing + DRIFT hybrid | important | `memory.search(mode='auto')`: narrow entity-bearing → local; thematic/aggregate → global; ambiguous → DRIFT (global to find the community, local inside it). Routing decisions logged with eventual feedback so the optimizer can retrain the heuristic per project. |
| Memory brief (guide-not-oracle, part 1) | core | `memory.brief(task_description, budget_tokens)` returns a delimited advisory block: orientation lines, then ranked items each tagged `[id \| type \| confidence \| staleness \| last_verified \| times_helpful]`, plus a fixed footer contract: memories are ADVISORY; verify any path/symbol/command against the live repo; never cite memory as sole justification for a destructive action; report usefulness via `memory_feedback`. Contradicted/quarantined items appear only with a CONTESTED flag. |
| Verify-before-trust + mandatory feedback (part 2) | core | Tier 0 (free): existence checks via grep/AST. Tier 1: read the referenced region. Tier 2: execute in sandbox. Policy: navigation hints need nothing; memory informing a code edit needs Tier ≥ 1; memory justifying destructive ops needs Tier 2 or independent evidence. A post-task hook diffs injected ids vs emitted `memory_feedback(id, signal ∈ {helpful, harmful, confirmed, stale, contradicted})`; unanswered defaults to `unused` (weak decay). |
| Decay + reinforcement engine | core | Nightly: `strength *= 2^(−Δdays/half_life)`. Helpful: `strength += 0.3·(1−strength)`, `half_life *= 1.2` (cap 4× base) — repeatedly useful memories become near-permanent. Harmful: `strength *= 0.5`; two harmful signals → quarantined. Pinned records exempt. All parameters optimizer-tunable within the `[memory]` bounds (concrete values in `generated/memory-params.yaml`, never written to `lunaris.toml`). |
| Contradiction detection + resolution | core | Triggers: explicit feedback, NLI-style check on commit, or code-watch invalidation (file/symbol removed → dependent records flagged). LLM adjudication outcomes: SUPERSEDE (tombstone after 30d), SCOPE-SPLIT (both kept with refined conditions + `contrasts_with` edge), REJECT-NEW, or ESCALATE → UI conflict inbox. Nothing hard-deleted mid-resolution; every transition audited. |
| Pruning, archival, snapshots | important | Weekly prune: strength < 0.05, expired tombstones, stale quarantine → zstd archive then removed; orphan entities and never-reinforced AMBIGUOUS edges GC'd. Pre-destructive snapshot before any prune/import/migration; `lun memory restore <snapshot>`. Archive stays greppable ("did we ever know this?"). |
| Per-project isolation + global tier | core | No cross-project reads, ever — except `~/.lunaris/global-memory/` mounted READ-ONLY (items tagged `tier=global`). Promotion: generality ≥ 0.8, helpful ≥ 3×, redaction pipeline (regex + LLM scrub for project identifiers — a pre-filter, never the authority) → rewritten project-agnostic → explicit human approval via a review queue (default) → global quarantine → promoted after proving helpful in a second project. Project memory always wins conflicts locally (global gets a `scoped_exception` edge). Disable per repo for confidential projects. |
| MCP server + CLI | core | Per-project MCP tools (auto-registered by the env manager): `memory_search`, `memory_brief`, `memory_commit` (agents propose, never write directly), `memory_feedback`, `memory_contradict`, `memory_explain`, `memory_stats`. CLI: `lun memory status\|search\|show\|pin\|forget\|prune --dry-run\|compact\|export\|import\|promote\|snapshot\|restore\|rebuild`. |
| UI surfaces | important | Memory tab: force-directed community graph (edge opacity ∝ confidence, dashed INFERRED/AMBIGUOUS), record inspector (edit creates a human-provenance version at confidence 1.0), conflict inbox with one-click rulings, retention dashboard (commit/discard/quarantine rates, decay curves, harmful list), and a per-task "why injected" trace. |
| Optimizer hooks | important | Every retrieval/injection/feedback event logged with scores-at-decision-time, token cost, and downstream outcome; the optimizer tunes gate weights, half-lives, brief budgets, routing heuristic, k-hop depth — never graph contents directly. |
| graphify interop | nice-to-have | `lun memory import-graphify <graph.json>` seeds memory from an existing /graphify run; `lun memory export --format graphify` keeps the existing HTML viz / Obsidian / Neo4j tooling working unchanged. |
| Code-watch invalidation | nice-to-have | File watcher / post-commit hook maps changed files to entities via `source_refs`; affected records bumped to `stale` and flagged `needs_reverify` so memory drifts toward truth as the code changes. |

### Architecture notes

- **Store:** single SQLite (WAL) at `.lunaris/memory/graph.db`. Tables: `entities` (kind ∈ code_symbol, file, concept, service, person, decision, task_type, error_mode, convention; aliases, community_id, embedding), `relations` (typed vocab: calls, implements, depends_on, decided_because, caused_failure, fixed_by, supersedes, contradicts, contrasts_with, scoped_exception…), `memories` (type, tier, body ≤200tok, strength, half_life, scores, status, pinned, provenance), `communities` (+ members), `conflicts`, `feedback_events`, `schema_meta`. Vector search via sqlite-vec; FTS5 for lexical entity linking.
- **Access:** RPC only (`memory.query/write/curate/brief`) — orchestrator, subagents, and UI never open the file, eliminating multi-writer corruption by construction. All operations emit `memory.*` events to the spine.
- **Portability:** deterministic JSONL export at `.lunaris/memory/export/` (committable, mergeable, rebuildable via `lun memory rebuild`) — the binary DB stays gitignored while curated knowledge travels with the repo. This export doubles as committed seed state for fresh clones.
- Scheduler jobs (nightly decay, weekly prune, resummarize, snapshot-before-destructive) run as `kind=system` schedules in the unified scheduler (§11).

### Integration points

- **Orchestrator:** `memory_brief` at task start; decomposition hints from procedural/episodic records; `memory_commit` proposals at task end (the gate decides — default keep-rate target < 20%); verification outcomes update confidence.
- **Subagents:** receive specialty-filtered briefs via the context packer; memory MCP tools in their toolset.
- **Optimizer / Analytics:** consume `memory.*` events; memory-effectiveness rollups (used-in-output rate, contradiction rate, success correlation) quantitatively enforce guide-not-oracle.
- **ModelGateway:** all extraction/summarization/adjudication/embedding calls route through the gateway (local Ollama default for embeddings; vectors stamped with model+dim, mismatch triggers re-embed migration).

---

## 5. Orchestrator + Subagent Engine

### Overview

Every project has exactly one persistent, resumable orchestrator that decomposes goals into a dependency-aware task DAG and executes it by spawning specialized subagents (coder, reviewer, tester, researcher, devops, plus user-defined roles), each with its own system prompt, tool allowlist, model binding, and sandbox drawn from the project env. Coordination happens through a SQLite task board, orchestrator-mediated message envelopes, and content-addressed artifact handoff with a git worktree per coding task. The orchestrator consults memory (advisory, verified before trust), checkpoints continuously for multi-hour unattended runs, and escalates only when genuinely blocked.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Persistent orchestrator lifecycle | core | One orchestrator identity per project: COLD → BOOTING → ACTIVE → IDLE → HIBERNATED → RESUMING. Identity lives on disk, not RAM — the daemon can restart, the machine can reboot, the orchestrator resumes mid-task. The one-orchestrator invariant is a fenced TTL lease (§15), not a pid file. |
| Event-sourced journal + resume | core | All state changes append to `.lunaris/state/runs/<session>.jsonl` (goal_created, plan_committed, task_spawned, lease_granted, gate_verdict, checkpoint_written…). Resume = latest checkpoint + journal-suffix replay; the rebuilt board is byte-identical. Chat-context compaction via a cheap model when nearing the context limit. |
| Goal contracts | core | Every request becomes `{goal_id, prompt, acceptance_criteria[] (drafted by the orchestrator, shown once), budget {max_usd, max_tokens, max_wallclock}, autonomy_level (full\|gated\|dry-run), priority, deadline?}`. No re-asking for consent inside the envelope; acceptance criteria make "done" machine-decidable where hard signals exist (tests, build, lint, type-check) — for soft goals (research, docs, architecture) acceptance = LLM-judge rubric + user acceptance. |
| DAG decomposition + re-planning | core | Planner pass (strongest model) emits task nodes: `{task_id, role, instructions, inputs (artifact/memory refs), expected_artifacts, acceptance_checks, est {tokens,usd,minutes}, deps[], pattern, max_attempts, model_hint?}`. Nodes may be EXPANDABLE (subagent returns a sub-plan; spliced in, depth limit 3). Failure triggers incremental re-plan of the affected subgraph only. Re-planning may mark previously-completed nodes stale when later work invalidates their assumptions; stale nodes spawn revalidation tasks, and already-merged work can be reverted through the git safety net (§6). |
| Declarative roles | core | `.lunaris/roles/*.role.yaml`: `{name, version, extends?, system_prompt (template with {{project_conventions}}, {{memory_slice}}, {{task_card}}), tools allow/deny (resolved against the env — a role can never use an uninstalled tool), mcp_servers, skills, model_binding {primary, fallbacks, params}, context_budget_tokens, memory_scopes, output_schema, sandbox, max_runtime}`. Role manager lints on install; UI role editor with test-fire. |
| Built-in role library | core | CODER (worktree-scoped edit/bash/test); REVIEWER (read-only + diff tools; MUST use a different model/provider than the author; verdicts with line-anchored findings); TESTER (spec-blind: sees acceptance criteria + interfaces, not the diff); RESEARCHER (web/docs, no fs writes outside notes); DEVOPS (network-enabled, destructive ops policy-gated); plus ARCHITECT, DEBUGGER (repro-first), SECURITY-AUDITOR, DOCS-WRITER, SUMMARIZER (cheap model, used by the context packer). |
| Model routing per task | core | Spawn-time resolution via `route.resolve(task_class, complexity_tier, agent_role)` — never by reading routing.yaml directly. Role binding → routing rules → provider health filter → fallback chain. Cheap local models for summarization/classification/compaction; frontier models for planning/architecture/review. |
| Spawning patterns | core | Seven composable primitives: SOLO, FANOUT (+merge task), PIPELINE (researcher→architect→coder→tester→reviewer), REVIEW GATE, ADVERSARIAL (author + independent critic on different models, K rounds), RACE (2-3 cheap models, first to pass acceptance wins), MAP-REDUCE. Patterns nest. |
| Review gates | core | Default: all code-mutating tasks get a REVIEWER gate + spec-blind TESTER run. Verdict `{approve\|request_changes\|escalate, findings[{severity,file,line,claim,fix?}], confidence}`. N-strike rule (3 rounds) → third-model arbitration → escalate with both positions. Reviewer/author model diversity enforced by the router. |
| Shared task board | core | `.lunaris/state/board.db` (SQLite WAL): goals, tasks, deps, attempts, leases (heartbeat 30s; expiry returns task to READY), messages, artifacts, gate_verdicts, escalations, checkpoints. States: PENDING → READY → LEASED → RUNNING → NEEDS_REVIEW → DONE/FAILED/BLOCKED/CANCELLED. Only the orchestrator mutates state; no hidden in-memory state. |
| Message passing (hub-and-spoke) | important | All messages route through the orchestrator. Envelope: `{msg_id, from, to, type: question\|status\|artifact_ready\|blocker\|finding\|handoff, body ≤2k tokens (longer content must be an artifact ref), refs[]}`. Direct sibling channels only for adversarial loops, fully logged. |
| Artifacts + worktree isolation | core | Code: one git worktree + branch `ai/<goal>/<task>` per mutating task under `.lunaris/worktrees/`; an integrator step merges in DAG order, runs the full suite, resolves conflicts via a coder subagent. Documents/data: content-addressed blobs in `.lunaris/state/artifacts/<sha256>` with a ≤200-token summary generated at publish. Handoff is always by ref — summary first, full content on demand. |
| Context packer | core | Within the role's budget, in priority order: role prompt → task card → project conventions → ADVISORY-tagged memory slice → input artifact summaries → retry failure digest. Overflow resolved by SUMMARIZER compression, never by silently truncating the task card. Subagents never see the orchestrator transcript or sibling chatter. |
| ResultEnvelope | core | Every subagent terminates with `{task_id, status: success\|partial\|failed\|blocked\|needs_decomposition, summary ≤500 tokens, artifacts[], metrics, confidence, open_questions[], risks[], memory_proposals[], subplan?}` — schema-validated with one self-repair pass. The orchestrator ingests only envelopes/verdicts, never raw transcripts (those go to disk for UI + optimizer). |
| Failure taxonomy + retry ladder | core | TRANSIENT → backoff retry (3×); TOOL_FAILURE → insert a DEVOPS fix-env task; QUALITY → retry with failure digest + reviewer findings appended; MODEL_INADEQUATE → reassign up the capability ladder (recorded for routing learning); TOO_BIG → re-plan finer; BLOCKED_ON_USER → escalate. Every task outcome additionally carries `failure_class ∈ {infra/environment, agent/model, policy-denied, user-cancelled}`; the optimizer excludes infra/environment failures from model- and prompt-quality statistics (§9). Full attempt lineage kept for the optimizer. |
| Escalation discipline | core | Only for: missing credentials; irreducible ambiguity; policy-gated actions; budget exhaustion; gate deadlock. Record: context summary, the specific question, 2–4 options with a recommended default, what continues meanwhile. The orchestrator marks only the dependent subgraph BLOCKED and keeps executing independent branches. Configurable timeout can auto-take the default for low-risk classes. |
| Scheduler + concurrency | core | Nested semaphores: global max subagents (default 8), per-project (4), per-provider (rate-limit derived; Ollama VRAM-bound). Priority queue by (goal priority, critical-path length, age); gate tasks boosted. Rate-limit reactive (429 → provider cooldown + reroute). At >80% goal budget: cheapest viable model only, fanout halved. Low-priority runs checkpoint-preempted gracefully. |
| Checkpointing | core | Checkpoint = board snapshot + journal offset + WIP commits in each active worktree + live session ids/offsets + router state. Triggers: every 10 min, phase boundaries, before risky ops, graceful shutdown. Power cut loses ≤ seconds since last journal append. |
| Memory consultation in planning | core | Pre-plan queries: community summaries, entity neighborhoods for named modules, episodic records of similar goals. Load-bearing memories become explicit VERIFY steps in task cards; verification outcomes flow back as confidence updates. |
| Watchdog | important | Detects missed heartbeats, runtime overrun, token burn without progress, tool-call loops (same failing command ≥4×). Responses escalate: steering message → checkpoint-and-kill with failure digest. Watchdog kills are analytics events the optimizer learns from. |
| Plan templates + dry-run | nice-to-have | `autonomy_level=dry-run` renders the full DAG with cost estimates without executing. Successful DAG shapes saved as `.lunaris/templates/*.plan.yaml` the planner instantiates by slot-filling; improved by the optimizer. |

### Architecture notes

- Execution flow: `submit_goal` (or queue dispatch, §11) → acceptance criteria + budget → planner pass (memory + analytics priors) → DAG committed to board → scheduler marks READY → context packer + router → subagent in worktree → ResultEnvelope → gates → integrator merge → goal verification pass → memory curation (<20% of proposals kept) → idle-time optimizer.
- Invariants: only the orchestrator mutates task state; envelope-only context ingestion; artifact-ref data flow; ADVISORY-only memory injection; crash-resume from journal + checkpoint.

### Integration points

- **aienv:** role allowlists validated against the env snapshot; env changes trigger role re-validation.
- **Memory:** read-only planning queries, advisory injection, verification write-backs, curated proposals.
- **ModelGateway:** all turns via `gateway.complete()` with `{role, task_class}` hints; `context_length` errors fire a compaction callback; `budget_exceeded` escalates to planning.
- **PDP:** every tool call passes the enforcement point; gated actions become escalations; sandboxes enforce policy mechanically.
- **UI:** live DAG, transcript tails, cost meters, escalation inbox over the event stream; plan amendments arrive as events the orchestrator must acknowledge.

---

## 6. Autonomy & Safety Policy

### Overview

The trust layer that makes unattended multi-hour runs possible. Synchronous "may I?" dialogs are replaced by declarative per-project policy, OS-level sandboxing, a git-based undo fabric, and an asynchronous approval queue reserved for irreversible actions. Every tool call from every agent passes a single Policy Decision Point (PDP) in lunarisd: compiled allow/deny rules answer common operations in sub-millisecond time, the shell-AST analysis path takes low milliseconds, and the LLM intent classifier — reserved for ambiguous high-risk operations — may take seconds but never blocks low-risk work; agents never block on a human — denials carry machine-readable explanations the agent can adapt to, and queued actions park asynchronously while the agent continues other branches.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Per-project autonomy levels | core | L0 read-only (all mutations denied — audit/research agents); L1 supervised (workspace mutations allowed; each new action *category* generates one async confirmation, then auto-allows); L2 autonomous-in-sandbox (the default: zero prompts inside the sandbox + egress allowlist; only irreversible classes queue); L3 full-auto (per-class auto-approve rules, e.g. staging deploys — still sandboxed and budget-capped; "no asks" never means "no walls"). Overridable per subagent and per task. |
| PDP with layered policy | core | Layers merged: built-in hard floors (non-overridable: no force-push to protected branches, sandbox-always, audit-always, budgets-must-exist) → `~/.lunaris/config/policy.yaml` → `.lunaris/config/policy.yaml` (committed, PR-reviewed) → `config/policy.local.yaml` (gitignored) → session override. Precedence: deny > queue > ask > allow > level default. Hot-reloaded; every decision stamped with the matched rule id. Outcomes: ALLOW, DENY (+explanation), QUEUE, TRANSFORM (e.g. `rm` → move-to-trash), SANDBOX_REDIRECT. |
| Rule language (glob + AST matching) | core | Matches on tool name (incl. `mcp:<server>/<tool>`); command globs over the *parsed shell AST* (catches `rm -rf ~` through quoting tricks; per-segment evaluation of pipelines; unparseable/obfuscated commands fall back to the level's opaque-command default); `path_read`/`path_write` globs with symlink resolution; network domain globs (deny-raw-IP default); and semantic risk classes the executor tags (`fs.write.outside_workspace`, `vcs.history_rewrite`, `irreversible.deploy.prod`) so one rule covers tools that didn't exist when it was written. MCP tools declare risk classes + required domains in their manifests at install. |
| Sandboxed execution | core | Tool execution runs in a container (Docker/Podman; image declared in policy) or OS jail (bubblewrap/Landlock on Linux, sandbox-exec on macOS). Worktree bind-mounted rw; toolchains ro; host `$HOME`, `~/.ssh`, other repos, and harness config invisible. CPU/mem/pid/disk limits + per-command timeout. Sandbox strictness is orthogonal to autonomy level — even L3 runs jailed. The agent runtime (model loop, provider keys) lives on the host side; only tool execution enters the sandbox. |
| Egress allowlist proxy | core | All sandbox traffic forced through a per-project proxy sidecar; domain allowlist pre-seeded per detected stack (npm/pypi/crates/github/docs); DNS pinned; raw IPs denied. Denials return a structured error naming the allowed set so the agent can adapt or file an async egress request. LLM provider calls never transit the project sandbox — a compromised workspace cannot exfiltrate via the model channel. |
| Git safety net | core | Agents never touch the default branch. Branch + worktree per task; auto-checkpoint commits (10-min timer, plan steps, before any risky op) with structured trailers (`AIH-Task`, `AIH-Agent`, `AIH-Step`); pre-risky-op `git bundle` snapshots. Hard floors: no force-push/history-rewrite on protected branches, no `git clean -fdx` outside the worktree, no `--no-verify`. PR gate per project: `required` (merge only via auto-PR with summary, diff stats, test results, audit link) \| `auto_merge_on_green` \| `off`. |
| Irreversible-action gate + async queue | core | Registry of irreversible classes: prod deploys, payments, outbound comms, package publishing, DNS/cert changes, cloud resource mutation, data deletion outside workspace, force-push, secrets rotation. Triple detection: MCP manifest annotations → command classifiers (`terraform apply`, `kubectl delete`, `npm publish`, `DROP TABLE`…) → cheap LLM intent classifier backstop. The gate NEVER blocks synchronously: action enqueued with rationale + dry-run output where available (`terraform plan`, `kubectl diff`, rendered email preview); agent receives a ticket and continues other branches. Queued tickets carry `plan_epoch` + a precondition hash (e.g. worktree HEAD, task state); on approval the executor re-validates — a stale ticket auto-invalidates, the user is notified, and the orchestrator re-requests if the action is still wanted. UI: approve / deny / edit-then-approve / approve-always-for-class, batching, TTL (24h → re-plan), push notifications. |
| Budget guards | core | Single enforcement point: the ModelGateway's transactional BudgetLedger (atomic reserve at admission, settle on completion, refund on failure) enforces `config/budgets.yaml` (`usd_per_task/run/day`, `soft_warn_pct`, `on_exceed: pause\|degrade-to-cheaper\|abort`). At 80%: in-band warning + degrade to cheaper/local models. At 100%: checkpoint-and-pause + notification. Runaway protection (sustained cost-rate spike) pauses immediately. Metered executor-side, never agent-self-reported. |
| Kill switch + pause | core | PAUSE (finish in-flight call, snapshot loop state, resumable), SOFT-STOP (finish current step, checkpoint, handoff note), HARD-KILL (SIGKILL, credential leases revoked, queued actions cancelled, post-mortem written by the executor). Addressable per subagent/task/project/global; one click in UI, `lun kill <project> [agent]` in CLI; automated triggers (budget breach, anomaly detector) invoke the same code path. |
| Structured denial feedback | important | DENY returns the matched rule, a human-written rationale, and actionable alternatives — guardrails become steering. Escalation ladder: 3 denials at one rule → orchestrator re-plans; 6 → task auto-paused + notification (persistent boundary-testing = confused agent or prompt injection). |
| Anomaly watchdog | important | Executor-side heuristics, outside the agent loop: command loops, file-churn thresholds, egress volume spikes, secret-access deviation, context thrash. Per-detector response: log / warn / pause / hard-kill. Agents cannot disable them. |
| Policy editor + approval UX | important | Safety panel: autonomy slider with plain-language consequences, rule list with live what-if tester ("would `rm -rf node_modules` be allowed?"), budget dials. Approvals inbox with dry-run context and mobile push. Audit timeline with git-diff click-through. |
| Optimizer-proposed tuning | nice-to-have | The optimizer mines approval history (classes approved 100% → auto-approve candidates) and denial friction, emitting policy diffs as proposals. Asymmetric ratchet: tightening may auto-apply; loosening ALWAYS requires a human; hard floors are never proposable. |
| Prompt-injection containment | core | Untrusted content (web fetches, third-party issue text, package readmes, MCP outputs) is taint-tagged in context; a tainted context switches the agent to a stricter PDP profile — no secret-adjacent tools, tighter egress (restricted to already-used domains), more action classes queued for approval (irreversible → hard-deny). Broker-held secrets + egress allowlist bound the blast radius of a hijacked agent. A documented threat model ships with the harness. Lands in the Phase 2 safety floor (§17). |

### Architecture notes

- **Wire protocol (PEP→PDP):** request `{project_id, task_id, agent_id, tool, args, parsed_command_ast?, risk_classes[], tainted, cwd, resolved_paths[]}` → response `{decision, rule_id, message, transformed_call?, queue_ticket?}`; sub-millisecond target for the compiled-rule path, low milliseconds for shell-AST analysis, seconds for the LLM intent classifier (ambiguous high-risk operations only, never on the low-risk path). Queue resolution events stream back on the ticket.
- **Command analysis pipeline:** raw command → shell AST parse (mvdan/sh or tree-sitter-bash) → expansion-aware normalization → risk-class tagging → path resolution with symlink chasing → PDP.
- Budgets, secrets, and audit all delegate to the Harness Core singletons (§2.5–2.7): no `vault/` dir, no policy-side budget copies, no separate audit DB — policy decisions are hash-chained events on the spine.

### Integration points

- **Orchestrator:** in-band DENY/QUEUE as structured tool errors; budget warnings and degradation directives; pause/resume snapshots on watchdog command.
- **UI:** approvals inbox, safety panel, audit timeline, kill/pause on every agent card.
- **Optimizer:** consumes approval/denial/incident statistics; emits proposals under the asymmetric ratchet.
- **aienv/plugd:** installing a capability merges its declared scopes into effective policy as a reviewable diff; disabling revokes them.
- **lunaris-id (§15):** approvals require operator+ role and requester ≠ approver; kill switch is deliberately low-friction (valid session only); resume requires elevated role + step-up.

### Failure-mode matrix

The binding contract for degraded operation; every row is mechanically testable and `lun doctor` checks the detection hooks exist.

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| Daemon crash mid-task | launchd/systemd supervision; socket health in `lun daemon status` | Crash-only design: fsync'd journals + checkpoints lose at most seconds | Restart → resume from latest checkpoint + journal-suffix replay (§5) |
| Crash after a side-effecting tool call, before event flush | Write-ahead intent record precedes every side-effecting call; idempotency keys forwarded to MCP servers/tools where supported | Intent record exists without a matching completion event | Reconciliation pass on resume compares intents vs observed effects (fs/git/API state); idempotency keys suppress duplicates; unresolved divergence escalates |
| Provider outage | Circuit breakers + error taxonomy (§7) | Fallback chain; when exhausted, affected tasks park BLOCKED with checkpoints | Health prober closes the breaker; parked tasks auto-resume |
| Budget exhaustion mid-DAG | Transactional BudgetLedger `reserve()` fails (§2.7) | Checkpoint + park the goal; notify | Human raises the cap or resumes in degraded (cheaper-tier) mode |
| Invalid config on disk | ConfigD fsnotify validation (§2.5) | Last-good generation stays live; bad content quarantined; `config.invalid` event → UI/CLI alert | Fix the file; successful validation hot-reloads |
| Orchestrator lease loss / zombie writer | Heartbeat expiry; epoch fencing (§15) | Stale-epoch writes rejected (409 LEASE_FENCED); zombie checkpoints and exits | New holder acquires the lease at a higher epoch, resumes from board + journal |
| Stale approval ticket | `plan_epoch` + precondition hash re-validated at approval time | Ticket auto-invalidates; user notified | Orchestrator re-requests if the action is still wanted |
| Network loss | Provider probes + gateway error rates | Per-subsystem degrade: memory-extraction queues park, NLI contradiction checks skipped, optimizer judges disabled, routing goes local-model-only | Queues drain and checks re-enable on reconnect |
| Event-spine disk pressure | Ring-buffer depth + disk watermarks (`obs.dropped_events`) | Payload refs dropped only per explicit retention policy; usage/audit/budget envelopes NEVER dropped | Every drop recorded as an integrity event; retention policy / disk reviewed |

---

## 7. ModelGateway — Multi-Provider Model Layer

### Overview

The single chokepoint for every LLM call: orchestrator turns, subagent work, memory summarization, embeddings, and the optimizer's own meta-calls. One unified completion/streaming/tool-calling/structured-output API over Anthropic, OpenAI, DeepSeek, Gemini, Ollama, OpenRouter, and any OpenAI-compatible endpoint, backed by a capability-aware model catalog, the declarative routing policy in `config/routing.yaml`, fallback chains with circuit breakers, and the `llm.usage` event stream that feeds analytics and the optimizer. The gateway is a stateless lunarisd module: it reads merged routing via `lunaris-config.watch()`, fetches keys as SecretBroker leases, and enforces budgets via its transactional BudgetLedger (reserve/settle/refund, §2.7) — it owns no private key vault, no private telemetry DB, and no private routing history (all deleted in favor of the Harness Core singletons).

### Features

| Feature | Priority | Notes |
|---|---|---|
| Unified completion API | core | `gateway.complete(req) → AsyncIterable<UnifiedEvent>` (streaming-first; `collect()` folds to a response). Request carries multi-part messages, tool definitions (JSON Schema), toolChoice, responseFormat, sampling params, routing hints `{role, task_class, tier, qualityFloor, privacy, maxCostUSD, latency}`, trace metadata, cache directives. Callers NEVER name a provider — they name a model id, a tier (frontier/workhorse/cheap/local), or just role + task_class. |
| Provider adapter SDK | core | Each provider is a ~400-line adapter: `translateRequest`, `stream`, `normalizeEvent`, `extractUsage`, `classifyError` (closed taxonomy: rate_limit / auth / overloaded / context_length / content_filter / network / invalid_request / server), `countTokensApprox`. First-party: anthropic, openai, deepseek, gemini, ollama, openrouter, generic `openai-compatible` (covers vLLM, LM Studio, Together, Groq with zero code). Third-party adapters drop into `~/.lunaris/providers.d/` or arrive as plugins (§12). |
| Streaming normalization | core | Canonical event stream: `message_start`, `text_delta`, `thinking_delta` (Anthropic extended thinking, DeepSeek reasoning_content, OpenAI reasoning summaries → one event so the UI renders a unified thinking pane), `tool_call_start/delta/end`, `usage`, `message_end{stopReason}`, `error`. Monotonic epochs let consumers dedupe after mid-stream fallback restarts. |
| Tool-calling normalization | core | One tool format compiled per provider: Anthropic tool_use/tool_result blocks; OpenAI/DeepSeek functions + role:'tool'; Gemini functionDeclarations with an automatic schema down-compiler (strips $ref/$defs, flattens anyOf); Ollama native tools where supported, else ReAct scaffold. Args validated against the tool schema before reaching the executor; malformed args get one automatic repair turn. |
| Structured output normalization | core | `responseFormat: json_schema` honored everywhere via per-model strategy: OpenAI/DeepSeek native strict; Anthropic forced-single-tool trick (unwrapped transparently); Gemini responseSchema; Ollama grammar constraint; prompt-only scaffold otherwise. Always validator-checked with a repair loop (N=2); persistent failure advances the fallback chain. `schema_retry_count` lands in the ledger so the optimizer can demote schema-unreliable models. |
| Provider registry + health | core | Providers declared in `lunaris.toml [providers]` (project) and `~/.lunaris/config` (machine defaults); managed via `lun provider add\|list\|enable\|disable\|test`. Live health per provider: circuit breaker (closed/open/half-open), rolling error rate, rate-limit windows, measured p50 TTFT and tok/s per model. A lightweight prober validates keys at registration. Health feeds the router and the UI status board. |
| Model capability catalog | core | Layered: shipped `models.yaml` → optional remote refresh → machine overrides. ModelEntry: context window, max output, modalities, toolCallQuality (1–5, blended with this project's own ledger), structuredOutputMode, cost per Mtok (0 or configurable compute-cost for Ollama so local-vs-cloud comparisons stay honest), latency class + measured rolling stats, tier, knockout flags, sunset dates. Queryable: `catalog.select({minContext, modality, tier})`. |
| Routing policy engine | core | Sole source: `config/routing.yaml` (§2.4 schema: defaults + prioritized rules matching task_class globs / complexity_tier / latency_class / agent_role → provider_alias + model + params + fallback_chain). Resolution: hard filters (provider healthy, context fits with output headroom, modalities, tool-quality floor, privacy local-only, structured-output capability, budget) recording `filteredBy` for the explain trace → utility scorer (quality/cost/latency/reliability weights, optimizer-tunable) → top pick; runners-up form the implicit fallback tail. Every call attaches a RouteDecision explanation ("why this model"). |
| Fallback chains + circuit breakers | core | Error-class retry matrix: rate_limit → honor Retry-After once, advance; overloaded/network/server → backoff ×2, advance; auth → mark unhealthy, notify; context_length → re-route to larger window AND fire a compaction callback; content_filter/invalid_request → no blind retry, escalate. Mid-stream failures restart on the next candidate with epoch-deduped output. `fallback_depth` recorded per call. OpenRouter as optional meta-fallback of last resort. |
| Usage ledger hooks | core | Every call (success or failure) emits `llm.call`/`llm.usage` events: model, provider, tokens in/out/cached, `cost_usd` snapshotted from the pricing table at call time, ttft/total ms, stop reason, fallback depth, cache-hit tier, schema retries, `config_rev`. Joined with task outcomes in DuckDB — the single source of spend truth and the optimizer's training signal. Pre-flight cost estimates let budget guards veto before spending. |
| Budget enforcement | core | The gateway is the ONLY budget enforcement point: the transactional BudgetLedger atomically reserves the estimated cost at admission against `config/budgets.yaml` caps (reservation counted immediately), settles actual cost on completion, refunds on failure — concurrent subagents cannot collectively overshoot a cap. Soft breach clamps to cheaper tiers + notifies the orchestrator; hard breach fails fast with `budget_exceeded`. |
| Response caching (3 tiers) | important | L1 exact (SHA-256 of normalized request → `.lunaris/state/cache/llm/`; temperature==0 or explicit only, TTL-bounded). L2 semantic (embedding cosine ≥ 0.97; restricted to idempotent task classes — never stateful agent turns). L3 provider-native prompt caching: automatic Anthropic `cache_control` breakpoints at stable prefix boundaries (system prompt + tools kept byte-stable per session for this), OpenAI/DeepSeek implicit prefix caching via stable ordering, Gemini cachedContents. Hits recorded so analytics shows real savings. |
| Unified embeddings | important | `gateway.embed(texts[], {purpose})` with the same routing/ledger treatment: local Ollama default, hosted fallback; model + dimensions stamped on every vector so the memory graph never silently mixes incompatible embeddings. |
| Token counting + preflight | important | Per-family tokenizers (tiktoken-class, Anthropic count-tokens, calibrated chars/4 heuristic) power context-fit filtering, compaction triggers at fill ratios, and cost estimates; counts reconciled against provider-reported usage post-call, drift auto-tunes the heuristic. |
| Vision normalization | important | Unified image parts translated per provider (base64/url/file; size caps, downscaling); router filters out non-vision models; a forced non-vision model triggers an automatic caption-then-describe preprocessing call, flagged in the trace. |
| Shadow + canary execution | important | The optimizer's safe experimentation substrate: SHADOW duplicates X% of eligible non-stateful calls to a candidate model (result discarded, scored offline, capped budget); CANARY routes Y% of live traffic via a ConfigD canary rev with auto-rollback on success-rate drop. All changes flow through ConfigD (§2.5) — no gateway-private history. |
| UI surface | nice-to-have | Provider cards (test connection, model lists, Ollama pull with progress), catalog browser, routing editor with dry-run trace, health board, spend meters, cache stats — all over lunarisd RPC. |

### Architecture notes

- Internal call order: RequestNormalizer (canonicalize, inject cache breakpoints, redact) → ResponseCache (L1→L2) → Router → BudgetGuard → FallbackExecutor (adapter translate/stream/normalize per candidate) → SchemaEnforcer → event emission. Side components: ProviderRegistry + HealthMonitor, ModelCatalog, TokenCounter.
- Provider quirks handled in adapters: Anthropic system param + tool_result-as-user-blocks + thinking round-trip; DeepSeek reasoner reasoning_content + "json-in-prompt" quirk; Gemini schema down-compiler + File API for large payloads; Ollama keep_alive management (cold-load penalty fed into the latency score).
- One shared connection pool with per-provider concurrency caps so a subagent swarm can't rate-limit the whole project.

### Integration points

- **Orchestrator/subagents:** all turns via `gateway.complete()`; RouteDecision attached to traces; compaction callbacks; budget escalations.
- **Memory:** extraction/summarization/adjudication as `memory.*`/`summarize` task classes (local tier default); all KG vectors via `gateway.embed()`.
- **Optimizer:** consumes usage × outcomes joins; rewrites routing.yaml via ConfigD with shadow/canary rails.
- **SecretBroker:** keys fetched as leases at call time; redaction middleware scrubs key material from every log/trace/error.
- **UI:** settings + status surfaces; unified event stream renders identically regardless of provider.

---

## 8. Observability + Analytics

### Overview

The flight recorder and instrument panel. Every LLM call, tool invocation, subagent spawn, memory lookup, and lifecycle transition is captured as a structured event in an OTel-style trace tree on the event spine (§2.7), persisted local-first under `~/.lunaris/projects/<id>/`. It powers live and historical dashboards, full-fidelity failure forensics (every LLM request/response and tool args/results captured) with recorded-response simulation, statistical regression detection with automatic attribution, and is the sole data feed for the optimizer. Design principle: lossless at capture, aggressively summarized at query time; payloads are stored separately from metrics so they can be redacted/expired independently.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Universal event schema | core | The §2.7 envelope, with typed extras per event_type: `task.*` (task_class, git_sha_before/after, files_touched, verification_result), `llm.call/usage` (full token/cost/latency breakdown incl. cache + reasoning tokens, retry_index, rate_limited), `tool.invoked` (tool_source builtin\|mcp:*\|skill:*\|plugin:*, exit code, bytes), `agent.spawn/end`, `memory.*` (entities touched, was-used-in-output, verification outcome), `routing.decision` (candidates + scores), `config.committed` (the attribution anchor for regressions), `user.intervention`. Everything queryable without touching payload blobs. |
| OTel-style trace model | core | One trace per task: TASK root span → AGENT spans → operation spans (LLM_CALL, TOOL_CALL, MEMORY_OP, ROUTING). The orchestrator mints trace context at task start; every spawn and adapter call carries `{trace_id, parent_span_id}` — subagents never invent trace identity. Span events (`context_compacted`, `retry_scheduled`) and span links (`replay_of`, `memory_from`) supported. Parallel subagents are sibling spans → Gantt/waterfall + critical-path math. Field names follow OTel GenAI conventions so OTLP export needs no translation. |
| Local-first dual store | core | Hot path: append-only JSONL segments via a non-blocking in-process ring buffer (instrumentation must never block or crash a task; under pressure, payload refs are dropped only per the explicit retention policy — usage/audit/budget envelopes are never dropped — and every drop is recorded as an integrity event via `obs.dropped_events`). Cold path: DuckDB index `events.duckdb` with materialized views; segments older than a window optionally compacted to zstd Parquet partitions readable through the same unified view. Payload blob store: content-addressed, deduplicated (`blobs/<sha256>.zst` — identical system prompts stored once), refcounted, secrets scrubbed at write time. Retention knobs per project: envelopes default keep-forever (tiny), payloads default 90 days. Optional `~/.lunaris/observability-global.duckdb` ATTACHes every project read-only for cross-project views. |
| Metrics engine: rollups + scorecards | core | Rollup worker (on task.end + 5-min timer) maintains: `task_summary` (one row per task: duration, critical path, cost, tokens, retries, outcome, verification, interventions, memory hits/contradictions, config_rev); hourly/daily rollups keyed by (project, bucket, dim) for dim ∈ {task_class, agent_role, model, provider, tool, mcp_server, skill} with t-digest latency sketches; `model_scorecard` per (model, task_class) — success rate, $/successful-task, median latency, retry rate (the exact table the router reads); `agent_scorecard` (incl. wasted-work inside failed tasks); `tool_scorecard` (error rate, latency, result size — flags chatty MCP servers bloating context). Metric definitions live once in a `metric_defs` registry shared by UI, alerts, and optimizer. Rollups are idempotent and recomputable from raw events. |
| Cost accounting + pricing table | core | Versioned `pricing` table (provider, model, effective_from, $/Mtok in/out/cache/reasoning) shipped with releases and editable in settings (negotiated rates; configurable compute-cost for Ollama). `cost_usd` frozen onto each event at write time; token counts retained so cost can be re-derived under hypothetical pricing ("what would this month cost on DeepSeek?"). Emits `budget.warn/exceeded` events the orchestrator subscribes to. |
| Live streaming for the UI | core | The writer fans events to per-project pub/sub; `WS /api/projects/{id}/events?since=<event_id>&filter=<expr>` streams ndjson with ULID cursors — a reconnecting UI replays the gap from disk then goes live; no missed or duplicate renders. Server-side filter expressions keep low-power views cheap. |
| Dashboards | core | (1) Project Overview: 30-day sparklines, top failing task types, top cost drivers; (2) Live Agents board: growing trace waterfalls, per-subagent status/cost ticking, pause/cancel; (3) Task Explorer: filterable task_summary with click-through to forensics; (4) Cost Explorer: stacked breakdowns, cache savings, budget burn-down, repricing simulator; (5) Model Comparison heatmap (model × task_class, $/success annotated); (6) Tool/MCP Health; (7) Optimizer Audit: config_rev timeline with before/after metric deltas. |
| Failure forensics + replay | core | Because every `llm.call` stores request/response refs and every tool call stores args/result refs, any task's transcript reconstructs in full fidelity: waterfall with failures highlighted; interleaved transcript diffable against a sibling successful run; context inspector with provenance coloring (which lines came from memory vs skill vs files — how you debug "memory misled the agent"); workspace state (git SHAs, per-tool diffs). Replay modes: read-only step-through; re-run a single call with edited prompt/model; re-run from a span boundary in a fresh worktree with recorded tool results optionally mocked. Replays are traced with `replay_of` links; only recorded-response (mocked) simulation is deterministic — re-execution against live providers is a new experiment, not a replay. One-click repro bundle (`.tar.zst`) export. |
| Regression detection + attribution | core | Post-rollup detector per (project, task_class) and (project, model): threshold rules → EWMA control charts (λ=0.3, 3σ) on cost/duration → CUSUM changepoints on success rate → two-proportion z-test for low-volume guards (28-day baseline, min 10 samples). The key feature: automatic attribution — changepoints joined against `config.committed`, `memory.prune`, and provider model_version drift, suspects ranked by temporal proximity. Alerts → UI inbox, toast, webhook, optimizer input; a regression attributed to an optimizer change triggers automatic rollback. |
| Optimizer data feed | core | The read contract: `GET /scorecards`, `GET /exemplars?task_class&outcome&n` (best/worst trace bundles for prompt analysis), `GET /experiments/{id}` (registered hypothesis + metric; verdicts computed with the same z-test machinery). The optimizer never touches raw storage. |
| Memory-effectiveness analytics | important | Per memory community/entity: retrieval count, used-in-output rate, verification outcomes, correlation of memory presence with task success. Memory leaderboard (most helpful / most misleading) in the UI; feeds curation/decay scoring — the quantitative backbone of guide-not-oracle. |
| Self-observability + integrity | important | `obs.dropped_events`, queue depth, flush latency, rollup lag, blob size in a Diagnostics panel. Idempotent writer (event_id PK); a janitor closes orphaned open spans as `outcome='orphaned'` on restart. Versioned envelopes keep old segments readable forever. |
| Export + interop | important | `lun obs export --from --to --format parquet\|csv\|jsonl\|sqlite --redact`; OTLP exporter (off by default) to any OpenTelemetry collector using GenAI semantic conventions; parameterized read-only DuckDB query endpoint over whitelisted views; webhook sink for alerts. Redaction enforced at the export boundary. |
| Anomaly snapshots | nice-to-have | During unattended runs, heuristics (token burn spike, tool loops, no-file-progress-in-30-min, cost slope vs estimate) emit `anomaly.detected`, snapshot the current context window to blobs (the moment of derailment preserved), and optionally pause pending review. |
| Cross-project benchmarking | nice-to-have | Global DuckDB attach compares projects ($/task, success, model mix) and flags transferable wins ("project A's testing prompt v3 beats B's v1 by 22pp on the same task_class") while keeping project data physically separate. |

### Integration points

- **Orchestrator:** mints trace context; subscribes to `budget.*` and `anomaly.detected`; its router reads `model_scorecard`.
- **ModelGateway:** the single source of `llm.*` events and spend; pricing table edited from settings.
- **Memory:** emits `memory.*` events; consumes effectiveness rollups.
- **Optimizer:** scorecards + exemplars + experiment verdicts are both its training data and its safety harness.
- **UI:** WS stream + named-query REST drive every dashboard, the forensics view, and all live cost tickers — one source of truth for numbers.

---

## 9. Recursive Self-Optimizer

### Overview

A per-project closed loop that turns the harness's own telemetry into measured configuration improvements: collect structured outcomes from every task, mine them nightly, have an optimizer agent propose diffs against the versioned config surface, trial each diff against a project-specific golden-task suite with paired A/B runs, then auto-adopt low-risk winners or queue higher-risk ones for one-click approval. Every change is a journaled, revertible ConfigD commit; every dollar it spends is metered under its own budget; and the guardrails it can never touch (budgets, policy, approval thresholds, its own rubric) live structurally outside its writable surface — the recursion is bounded by construction, not by prompt.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Outcome ledger | core | Every task/subagent run emits a TaskOutcome via runtime hooks (onto the event spine): config_rev at task start, role, task_class, model, wall time, token/cost breakdown, tool error counts, retries/escalations, outcome, memory ids injected vs cited vs contradicted, artifact stats. Eval runs flagged `is_eval` so optimization spend is itself observable. Stamping `config_rev` on every outcome is what makes impact attributable. |
| Success signal resolver | core | Three tiers, recorded separately: HARD (tests pass, build/lint clean, CI green, acceptance command exits 0) > SOFT (diff accepted, not reverted/reopened within 7 days, no "fix what you broke" follow-up) > JUDGE (pinned LLM judge scores the transcript against per-task-class rubrics in `.lunaris/evals/rubrics/`). Judge-only successes are flagged lower-confidence and need larger samples before driving proposals. |
| Pattern analyzer | core | Deterministic nightly SQL/stats job (no LLM): per (role, task_class, model) success rates with Wilson confidence intervals (min n ≥ 5), p50/p95 cost and latency, retry/escalation rates, tool friction (error + result-discarded rates), memory precision and contradiction rates, routing regret (cheaper models that passed the same goldens in shadow). Outcomes tagged `failure_class = infra/environment` (§5) are excluded from model- and prompt-quality statistics. Emits a ranked findings digest. |
| Proposal generator | core | An LLM agent (configurable model, can be local) receives the digest + current config and emits ≤ K (default 5) proposals per cycle. A proposal is never a direct write: it is a diff + machine-readable metadata — rationale, cited evidence (task_ids openable in the UI), expected impact (metric, baseline, predicted), risk score, and an eval plan. One concern per proposal; sweeping multi-file rewrites are schema-rejected. |
| Prompt optimization with protected regions | core | Per-role learned guidance lives in `.lunaris/generated/prompts/<role>.md` (optimizer lane); role identity/safety/autonomy blocks in `roles/*.role.yaml` are frozen — ConfigD refuses edits inside `<!-- PROTECTED -->` markers. Two ops with different risk: APPEND a guidance bullet (low risk, auto-adoptable: "this repo uses pnpm, never npm") and REWRITE/CONSOLIDATE (medium risk, approval; typically the weekly job merging bullets into prose). |
| Routing optimization + online bandit | core | Two speeds. (1) Per-task online: Thompson-sampling counters per (task_class, model) — no config mutation, exploration capped at 10%, only within the already-approved model set, never on critical-tagged tasks. (2) Nightly: rewrite `config/routing.yaml` via ConfigD when the posterior is decisive. Risk tiers: reorder among used models = low; >2× cost increase = approval; never-used provider/model = high, always approval. |
| Memory retention tuning | important | Tunes gate weights, half-lives, prune thresholds, brief budgets, retrieval params (written to `generated/memory-params.yaml`; human-lane knobs in `lunaris.toml [memory]` go through proposals). Driven by precision metrics: low cited/injected ratio → tighten; recall misses (new memory matching a tombstoned one) → loosen for that type. The optimizer proposes thresholds only — it never deletes specific memories. |
| Decomposition template optimization | important | Learns from outcomes ("feature tasks with a parallel tester had 22% fewer reopens"; "research fan-out beyond 4 adds cost, no success delta") and proposes edits to `.lunaris/templates/*.plan.yaml`. Medium risk; always evaluated against goldens of that task_class. |
| Tool selection optimization | important | Detects friction (high tool error rates, discarded results, repeated manual sequences an installed tool would replace) and proposes per-role tool hints (low risk, auto) or allowlist changes (capability expansion — always high risk, human approval). |
| Skill/MCP suggestion engine | important | Maps recurring manual patterns to installable registry capabilities ("ran playwright by hand in 14 tasks → install browser-testing skill") — never auto-installed; cards enter the env manager's install queue with evidence and projected savings. Disable proposals for installed-but-unused capabilities (each enabled MCP server costs context every task) are low risk. |
| Golden task suite + harvesting | core | `.lunaris/evals/golden/<id>/{task.yaml, snapshot.bundle, fixtures/}`: prompt, pre-task repo snapshot (git bundle), checks (pytest \| shell \| file_match \| judge_rubric), budget, tags. Harvesting: tasks succeeding with HARD signals offer "promote to golden" (auto when deterministic checks exist). Hygiene: 30–50 goldens stratified by task_class; drifted snapshots auto-retired; weekly recalibration quarantines flaky goldens. |
| Eval runner: paired A/B + statistical gating | core | Candidate config materialized via ConfigD canary slot; relevant goldens run under baseline AND candidate as paired runs (same snapshots, 3 reps) in disposable worktrees through the identical sandboxed executor as live tasks. Adoption bar: non-inferior on success (default 2pp margin) AND better on the target metric, or strictly better on success. Optional live canary (default 10% of low-stakes traffic for a day). Hard nightly eval budget (default $5/project). |
| Transcript replay smoke tests | nice-to-have | Cheap pre-eval filter for prompt changes: replay recorded transcripts with tool calls answered from recordings; check first-tool-choice match and plan similarity. Failures never reach the paid golden stage. |
| Versioned config + approval queue | core | All adopted changes are ConfigD journal revs with embedded proposal JSON (id, rationale, evidence, eval results, decided_by auto\|user). Deterministic risk rubric (human-editable only) maps category → risk; low + eval-pass auto-adopts; medium/high produce UI approval cards (diff, plain-language rationale, evidence links, eval scoreboard, Approve / Reject / Canary-first). Pending proposals expire after 14 days. A per-project slider moves the auto-adopt threshold; the optimizer cannot. |
| Guardrail engine | core | Enforcement is structural: ConfigD lanes reject any optimizer write to protected paths (policy, budgets, secrets, approval thresholds, risk rubric, eval scoring, judge pin, PROTECTED prompt regions); the optimizer agent's sandbox has no OS-level write access to them; guardrail content is hash-pinned at daemon start (mismatch → optimizer disabled + alert). Hard caps regardless of approvals: nightly eval spend, max auto-adoptions/day (default 3), max proposals/cycle, mandatory post-adoption monitoring. |
| Auto-rollback monitoring | core | Every adopted change opens a window (next 20 tasks or 72h). Success-rate drop beyond margin, or cost/task >50% over prediction → automatic rollback to parent_rev, incident in the learnings report, diff fingerprint blocklisted 30 days. >2 rollbacks in a week pauses auto-adoption for the project. |
| Cadence scheduler | core | PER-TASK (online, no LLM, no writes): outcome write, bandit counters, salience signals. NIGHTLY (idle-detected): analyzer → proposals → replay filter → golden evals → adopt/queue. WEEKLY: trend analysis, prompt consolidation, suite recalibration, skill suggestions. ON-DEMAND: "Optimize now" and "investigate this failure" targeted mini-cycles. All as `kind=system` schedules (§11). |
| Learnings report | core | Nightly `learnings-YYYY-MM-DD.{md,json}` rendered in the UI Learnings tab: headline metrics with sparklines, "What changed" (adopted diffs with measured-vs-predicted impact), pending approvals inline, "What we noticed" (failure modes with example tasks, memory hygiene, tool friction), suggestions, rollback incidents, and a short narrative. Push notifications only for rollbacks and high-risk approvals. |
| Spend accounting | important | All optimizer activity flagged `is_eval/is_optimizer` and shown as its own analytics line: "optimizer spent $11.20 this month; adopted changes cut cost/task 18%, raised success 6pp". Budget exhaustion throttles to next night, never kills. |
| Cross-project hints | nice-to-have | Provider-agnostic learnings exported as anonymized hints to `~/.lunaris/hints/`, offered to other projects as low-confidence starting proposals — always re-evaluated against the receiving project's goldens, never auto-adopted across projects. |

### Architecture notes

- Pipeline: spine events → DuckDB views → PatternAnalyzer (deterministic) → OptimizerAgent (LLM, ≤K diffs) → Guardrail filter → replay smoke → EvalRunner (paired goldens, sandboxed worktrees) → gate → risk scorer → ConfigD commit (low) / approval card (medium+) → post-adoption monitor → keep or auto-revert.
- The single write path is ConfigD's Propose → Validate → Canary → Commit → Auto-rollback pipeline (§2.5); the optimizer never touches disk. Human approvals are signed audit records (§15).

### Integration points

- **Observability:** sole data source (scorecards, exemplars, experiments); regression alerts attributed to optimizer revs trigger rollback.
- **ModelGateway:** shadow/canary substrate; bandit explores within the approved model set; pricing feeds cost signals.
- **Memory:** threshold tuning only; precision metrics flow back.
- **aienv:** install/disable suggestions into the env manager's queue; reads the lockfile to know what is installed and unused.
- **UI:** Learnings tab, approval cards, config timeline with one-click revert, optimizer settings (human-only).

---

## 10. Mission Control UI

### Overview

A local-first web app served by lunarisd — the single pane of glass. Multi-project mission control: pick a project, chat with its orchestrator, watch every subagent live, browse and curate the memory graph, manage the environment, review analytics and the optimizer, and clear the approval inbox. Chat-first but observation-heavy: the default posture is "the AI is already working; the UI lets you watch, steer, and audit." The UI is a pure RPC client — zero direct file IO — which is what keeps it from becoming another config writer. All real-time state arrives over one multiplexed WebSocket backed by the append-only event log, so reconnect-replay, timeline scrubbing, and audit come from one mechanism.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Global shell + project switcher | core | Left rail of registered projects (from `~/.lunaris/projects.toml`) with live chips: state dot, active-subagent count, spend today, unread approvals. Cmd+K palette ("pause project X", "approve pending #3"); global pause button; aggregate spend ticker; connection indicator. Cmd+1..9 pinned projects; Cmd+Shift+A approvals. |
| Home: all-projects overview | core | Grid of project cards: current goal one-liner, subagent avatars with micro-status, DAG progress bar, spend vs budget radial (amber at 80%), pending approvals, last failure strip. Global widgets: spend-today by provider, top-5 approvals (inline-approvable), recent completions, blocked-task list with reasons. Everything deep-links. |
| Orchestrator chat | core | Rich message blocks: plan cards (inline mini-DAG, editable before/during execution), delegation cards (click → live transcript), diff cards, artifact cards (screenshots, test reports), memory citations ("guided by M-203 — verified ✓ / unverified ⚠"), inline approval cards. Slash commands (`/pause`, `/redirect`, `/spawn researcher`, `/budget +$5`, `/pin-memory`); @-mentions of subagents. Mid-task messages queue as steering input injected at the next checkpoint (visible state) with an explicit Interrupt-now escape. Sessions are continuous and searchable. |
| Live agents view | core | Lanes (role, model badge, current task, elapsed, live token/cost counters, 3-line streaming tail) or a tmux-style grid of transcript tiles. Click → full transcript drawer: streamed output, collapsible tool calls (args, result, duration, exit code), diffs, sticky controls (Pause, Stop, Redirect, Reassign model, Escalate-to-me). Follow-tail, search, jump-to-error; completed agents stay inspectable; everything replayable via the timeline scrubber. |
| Plan tab (Kanban + DAG) | core | Synchronized Kanban (Backlog/Ready/Running/Waiting-Approval/Blocked/Review/Done/Failed) and auto-laid-out dependency DAG (status colors, executing pulse, critical path highlighted). Task detail panel: acceptance criteria, transcript link, artifacts, failure history, retry / retry-with-different-model / cancel / split. User edits are plan-amendment events the orchestrator must acknowledge; a replan-diff overlay shows mid-run changes. |
| Memory tab | core | WebGL force-directed graph with community hulls and semantic level-of-detail (zoomed out = community super-nodes; zoom in = entities). Entity inspector: properties, relations, provenance, confidence, verification state, usage stats. Curation everywhere: pin, edit (versioned), delete (30-day recoverable), merge, mark-stale, bulk ops, "verify now" (enqueues an orchestrator check). Decay panel: half-life sliders, what-would-be-pruned-next preview, undoable prune log. Unverified memories render dashed — the UI never presents memory as ground truth. |
| Environment tab | core | One page per capability class (Skills / MCP / Plugins / Tools), uniform package-manager UX: name, version, enabled toggle, source, scope badge (project vs inherited), health (MCP process state, restart), usage stats from analytics, permission summary. Install flow shows the manifest preview (tools, secrets, permissions) before confirming. Lockfile viewer with drift detection + one-click sync. Per-capability detail: rendered README, tool schemas, config form auto-generated from JSON Schema (secrets masked), sandboxed try-it console. Optimizer recommendations strip. |
| Analytics tab | core | KPI row (tasks 7d, success rate, spend, tokens, avg duration, interventions); charts (spend stacked by provider/model, tokens by role, duration percentiles by task type, success trend, cost-per-completed-task, failure Pareto); drill-down task table linking to replayable transcripts; model leaderboard with "what the router prefers and why"; CSV/JSON export; week-over-week comparator. |
| Evolve view | important | Optimizer proposals as reviewable change cards (side-by-side prompt diffs, routing changes, memory policy changes) each with its evidence query, expected impact, Apply / Reject / Auto-apply-class, and post-application A/B tracking. History log with one-click rollback. Banner shows the current auto-adopt setting. |
| Approval inbox | core | Global + per-project queue. Each item: requesting agent, the exact action payload rendered verbatim (never an LLM paraphrase), rationale, risk class + triggering rule, blast-radius summary, timeout behavior (block or auto-deny — never auto-approve). Actions: Approve; Approve + always-allow-pattern (shows the exact policy rule it will create); Deny with reason (fed back to the agent); Edit-then-approve. Batch approve for homogeneous items; full who/when audit. |
| Settings | core | Two-level (global defaults; per-project overrides with CSS-computed-style inheritance indicators). Providers page (key entry → OS keychain, last-4 display, test connection, Ollama model pulls with progress, rate caps). Routing page (rule table + dry-run tester + fallback chains + optimizer-managed toggle). Autonomy page (level slider + per-action-category matrix). Budgets (caps + on-exceed behavior). Notifications, theme, retention. |
| Event bus client + replay scrubber | core | One WebSocket, topic subscriptions, per-topic monotonic seq; reconnect sends last-seen seq and the server gap-replays from the log. Token streams coalesced ≤30Hz; hidden tabs auto-downgrade to 1Hz summaries. Every view gets a timeline scrubber — drag back to see agents/DAG/chat as of T-minus-10-minutes (the post-mortem tool for overnight runs). |
| Notifications | important | Three tiers: in-app toasts; OS-native (goal completed, run blocked, approval requested, budget threshold, error loops, provider outage, overnight heartbeat digest); webhook/Slack/ntfy for away-from-machine (critical-only default). Every notification deep-links to the exact view. Quiet hours + digest mode. |
| Steering verbs | core | Uniform everywhere: Pause (at next checkpoint, resumable), Stop (hard cancel; WIP committed to a scratch branch), Redirect (instruction injected at next checkpoint, visible in transcript), Reassign, Rewind (restore a prior checkpoint from event log + git snapshot, optionally redirect). Acknowledgement within 2s in-stream. Project-level Pause-all is one click from anywhere. |
| Run timeline / journal | important | One chronological merged narrative per project: goals, plans, spawns, approvals, memory writes/prunes, optimizations, budget events, errors — filterable, deep-linked, topped by an auto-generated natural-language summary ("Worked 6h12m, completed the payments refactor (23 tasks), spent $4.31, 1 approval pending"). The "what happened overnight" page. |
| Changes panel | important | All agent file modifications since the last review-mark: file tree, Monaco word-level diffs grouped by task, per-task looks-good / request-changes (the latter opens a pre-targeted redirect). Artifacts gallery (screenshots, rendered JUnit, build outputs). Links out to the real branch/PR. |
| Onboarding wizard | nice-to-have | Register repo → stack scan → proposed initial env (skills/MCP for the detected stack) + initial graphify pass to seed memory → pick autonomy level + budget → orchestrator introduces itself and asks for the first goal. Empty-project mode scaffolds repo + env together. |
| Health page | nice-to-have | Daemon version/uptime, event-log size, MCP process table, provider reachability matrix, Ollama VRAM, disk usage by store with retention controls, harness error log, support-bundle export. |
| Accessibility + theming | nice-to-have | Dark/light/system; compact density for the agent wall; full keyboard nav; reduced-motion (static layouts replace force physics); color-blind-safe status (icon shape + color, never color alone). |

### Architecture notes

- **Deployment:** lunarisd embeds an HTTP+WS server on `localhost:7340` serving the SPA and the API; usable from any browser. Optional Tauri 2.x native shell (~10MB) for tray, OS notifications, keychain, autostart, deep links (`lunaris://project/abc/approvals/42`); the browser stays first-class. Remote access via Tailscale/SSH tunnel; auth per §15.
- **Stack:** React 19 + TypeScript + Vite; TanStack Router (URL-addressable everything) + TanStack Query (REST) + Zustand (WS-fed live stores); Tailwind + shadcn/ui; Monaco (diffs/config); xterm.js (transcript tiles); React Flow + ELK (DAG); sigma.js/graphology with force-atlas-2 in a Web Worker (50k+ node KG); ECharts; Virtuoso for 100k-line virtualized lists.
- **Protocol:** WS for read/stream (envelope `{topic, seq, ts, type, payload}`; topics `global/*`, `project:{id}/chat|agents|tasks|memory|metrics|journal`); all mutations over REST for uniform auth/retry. SSE fallback.
- **Safety:** destructive UI actions are optimistic with server-confirmed undo windows; approval payloads always rendered from the raw action; in-memory transcripts capped at last 5k events with page-back from the log.

### Integration points

Every tab is a thin client of a subsystem's RPC surface: chat/plan → orchestrator; agents → runtime control + transcript topics; memory → Memory Service LOD graph API; environment → capability managers; analytics/evolve → DuckDB named queries + optimizer proposals; approvals/safety → PDP + approval queue; settings → ConfigD + SecretBroker; system → lifecycle subsystem (§13).

---

## 11. Autonomy Intake — Scheduler, Triggers & Goal Queue

### Overview

Goal sources beyond interactive chat: a durable prioritized backlog the orchestrator drains unattended, a user-facing cron for recurring goals (nightly dependency bumps, weekly refactor sweeps), and an external trigger layer (webhooks + pollers) that converts forge/CI/monitoring events — PR opened, CI failed, issue assigned, Sentry alert — into queued goals via declarative rules and parameterized templates. The internal cron jobs that already exist (memory decay, optimizer nightly) re-home into this same scheduler as `kind=system` entries: one scheduler primitive, zero parallel cron implementations. All unattended execution is wrapped in budget/policy guardrails with the async approval path as the single consent point.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Goal queue | core | Durable per-project backlog in `~/.lunaris/projects/<id>/automation.db`. Every source (UI, CLI, schedule, trigger, API) enqueues a QueueItem; interactive submit becomes a P0 enqueue. States: queued → leased → running → succeeded \| failed \| blocked \| needs_approval \| cancelled \| dead_lettered. Priority bands (P0 interactive, P1 triggered, P2 scheduled, P3 background/optimizer), `not_before`, `dedupe_key` uniqueness (a second "fix CI on main" coalesces), attempt counters, goal dependencies. Survives restarts; expired leases re-queue. |
| Schedule manager | core | Schedules fire goal templates on cron / interval / one-shot `at`: `{spec, timezone, jitter_s, template_id + params, enabled, concurrency_policy: skip\|queue\|replace, catch_up_policy: skip_missed\|run_once\|run_all, budget caps}`. Persisted `next_run_at` handles missed fires across downtime. Run-now, pause/resume, last-run summary. Seedable recipes: nightly dependency bump + PR, weekly dead-code sweep, daily TODO triage, weekly flaky-test hunt, docs drift check. |
| Goal templates | core | `.lunaris/automation/templates/*.yaml`: `{name, prompt_template (Jinja-style, filled from params or event payload), agent_profile, model_routing_hint, branch_policy (worktree + PR only, never the default branch), success_criteria, max_retries, default budget}` — diffable, reviewable, managed by the env manager like skills. |
| Webhook intake | core | `POST /hooks/{project_id}/{source}` on lunarisd. Per-source HMAC-SHA256 verification (X-Hub-Signature-256 etc.), raw payload snapshotted to the intake log, delivery_id dedupe, 202 immediately (async processing). Built-in tunnel helper (cloudflared/smee) + a "paste this URL + secret into GitHub" wizard for laptops without public ingress. |
| Trigger rules engine | core | `.lunaris/automation/triggers.yaml`: `{source, event_types[], filter (CEL over payload, e.g. conclusion == 'failure' && branch == 'main'), param_map (JMESPath extractions), template_id, priority, dedupe_key_expr, debounce_s, mode: live\|shadow, enabled}`. Every event gets a recorded verdict — matched / ignored / deduped / rate_limited / invalid_signature — so "why did(n't) the AI react?" is always answerable. |
| GitHub/forge adapter | core | Normalizes GitHub (App or repo webhook) events and ships canned rule+template pairs: issue labeled `ai` → implement-issue; PR opened → review; change requests on an AI-authored PR → address-feedback; CI failure on default branch → diagnose-and-fix; release published → changelog. Outbound reuses the `gh` PR-gate integration: progress comments link back, closing the loop. GitLab/Gitea follow the same adapter interface (important). |
| Dispatcher | core | Leases the highest-priority eligible goal, materializes a worktree, and invokes the orchestrator through the identical entrypoint as interactive submit — same lifecycle, same events. Enforces per-project and global run caps, a per-branch mutex (two goals never edit one branch concurrently), and preemption (incoming P0 checkpoints a running P3). |
| Unattended guardrails | core | Per-goal hard budgets inherited from template/schedule, enforced with graceful checkpoint-and-stop; per-project daily automation spend cap (within `budgets.yaml` MIN-merge); action policy for automated goals (PR-only output, no force-push, no destructive ops outside worktree). Out-of-policy needs → `needs_approval` with persisted checkpoint + notification; approve/deny resumes. Global + per-project kill switch. |
| Retry + dead-letter queue | important | Exponential backoff + jitter up to template max_retries; each retry is a fresh run receiving the prior failure summary. Exhausted goals dead-letter with full context (last error, spend, trace link); requeue / edit-and-requeue / discard from UI. N consecutive dead-letters auto-pause the schedule and notify. |
| Pollers | important | For push-less sources: poll GitHub via `gh` (no webhook access), CI status endpoints, RSS/CVE advisories, or a local drop directory (`.lunaris/inbox/*.md`). Pollers emit synthetic events into the same intake log + rules engine; cursor state persisted. |
| Intake log + correlation ids | important | Append-only record of every event with verdict and matched rule. A `correlation_id` minted at intake threads through goal → run → spans → PR/commit trailer (`AIH-Correlation-Id:`), so observability can answer "this Sentry alert cost $1.40 and produced PR #212". |
| System jobs unification | important | Memory decay/prune, optimizer nightly/weekly, log compaction, backups, GC, restore drills — all `kind=system` schedules: visible in the UI (badged), shared run history and cost accounting, retimeable/pausable but not deletable. |
| Notifications + digest | important | On terminal states and `needs_approval`: desktop, email, Slack/Discord, forge comments — severity-filtered per project. "While you were away" digest on next UI open: goals completed, PRs opened, failures, spend, pending approvals. |
| Automation UI tab | core | Four panes: Schedules (toggles, next-run countdown, cost sparkline, cron-helper wizard); Queue board (kanban, drag-to-reprioritize, deep-link into the live agent view); Triggers (rules table, webhook URL + secret rotate, live intake feed with verdicts); Approvals. Plus the kill switch and a daily automation budget gauge. |
| CLI + API | core | `lun queue push\|ls\|cancel\|requeue`; `lun schedule add\|ls\|pause\|resume\|run-now\|rm`; `lun trigger add-rule\|ls\|test --event sample.json` (dry-run prints matched rule + fully rendered prompt without enqueueing); `lun approvals ls\|approve\|deny`. Matching REST endpoints; the UI consumes the same API. |
| Shadow mode | important | Any schedule/rule can run in shadow: fires, renders, records what *would* have been enqueued with estimated cost — but doesn't execute. Validate a new nightly job against a week of real events before granting it budget. |
| Optimizer feedback | nice-to-have | Per-schedule/per-rule analytics (success rate, cost per successful run, PR merge rate) feed optimizer proposals: rewrite failing templates, route cheap sweeps to local models, widen debounce windows, auto-pause schedules whose PRs never merge — delivered as ordinary proposals against `.lunaris/automation/*.yaml`. |
| Quiet hours | nice-to-have | Per-project execution windows: defer triggered goals outside allowed hours (`not_before`), run expensive automation overnight, keep demo hours quiet. |
| Sentry/monitoring adapter | nice-to-have | Normalizes Sentry/Alertmanager/PagerDuty alerts (stack trace, release, frequency); canned triage template reproduces, bisects against recent harness-authored PRs via correlation ids, opens a fix PR or a diagnosis issue. |

### Integration points

- **Orchestrator:** identical entrypoint; runs can self-schedule follow-ups ("recheck this flaky test tomorrow").
- **aienv:** automation YAML is an env-managed artifact; plugins can contribute trigger sources with canned rules.
- **Memory:** terminal automated goals write outcome summaries to the graph (entity: schedule/rule → produced PR #N / failed-with X); rules may consult memory as a guide (verified before trusting).
- **Observability/Optimizer:** every automated run dimensioned by schedule_id/rule_id; optimizer nightly is itself a system schedule.
- **ModelGateway:** template routing hints + budget estimates via the pricing table; quiet hours prefer local models.

---

## 12. Plugin System ("plugd")

### Overview

Defines what a plugin IS: a signed, versioned, manifest-described extension package running OUT-OF-PROCESS in a supervised, OS-sandboxed Plugin Host, extending the harness only through declared, typed extension points. Plugins have no ambient authority: every privileged operation is a brokered host-API call checked by the PDP under a per-plugin principal, and the process itself is confined by an OS sandbox sized exactly to its grants. This gives the env manager's `plugin` package type a real payload contract and the UI's plugins tab real objects to manage.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Plugin manifest (`plugin.toml`) | core | `{id (reverse-DNS), version, hostApi (semver range), runtime: node20\|python312\|wasm-wasip2, entrypoint, contributions[], capabilities[], configSchema (rendered as a settings form), secrets[] (names only), services[], bundles[] (sub-packages of other capability types), signing metadata}`. Schema-validated at install; invalid manifests rejected before any code lands. |
| Typed extension points | core | Closed v1 set: **tools** (appear in agent toolsets like built-ins); **agent.roles** (custom subagent roles); **memory.extractors** and **memory.retrievers** (graph pipeline stages — proposals only, never direct writes); **events.consumers** (topic-ACL'd spine subscriptions); **hooks.lifecycle** (preToolCall — can deny/rewrite args; postToolCall; runStart/End; prePromptAssembly; preCommit); **provider.adapters** (new model backends registered with the gateway); **router.hints** (scoring callbacks in routing); **ui.panels** (sandboxed iframes). Each point has a versioned interface; the ContributionRegistry is the single lookup consulted by tool router, orchestrator, memory pipeline, gateway, event bus, and UI. |
| Out-of-process host + RPC | core | One supervised child process per plugin per repo env — never in the daemon. JSON-RPC 2.0 over stdio (UDS for streams). Handshake: `initialize{hostApiVersion, dataDir, config, grants}` → `register.contributions` (validated ⊆ manifest declarations) → ready. Per-call deadlines (default 30s, policy-capped) with cancellation. Crash isolation: supervisor restarts with backoff; a crash loop quarantines. |
| Brokered host API + PDP | core | Zero direct OS access. `host.fs.read/write/list` (path-scoped), `host.net.fetch` (proxied egress), `host.exec.run` (binary allowlist, sandboxed), `host.memory.query/propose`, `host.events.emit/subscribe`, `host.tools.invoke` (depth-limited), `host.models.complete/embed` (routed via the gateway — spend metered and attributed), `host.secrets.get` (just-in-time broker lease, never env vars/files), `host.config.get`, `host.state.kv`, `host.log/trace`. Every call: capability check → PDP check (principal `plugin:<id>@<version>`, trust tier) → quota → execute → audit. |
| Grants, consent, OS sandboxing | core | Layer 1: fine-grained capability grants (`fs.read:{paths}`, `net:{hosts}`, `exec:{bins}`, `memory.propose`, `models:{budgetUSDPerDay}`, `secrets:{names}`) approved once at enable; upgrades re-consent only on the grant DIFF — unattended runs never see plugin permission prompts. Stored at `.lunaris/capabilities/plugins/<id>/grants.json`. Layer 2: OS confinement generated from the grant set — bubblewrap + Landlock + seccomp + cgroups v2 (Linux), Seatbelt (macOS), wasmtime/WASI-P2 capability handles (strongest tier; recommended default for community plugins). Egress denied at the OS layer except via the host proxy. |
| Lifecycle + drain-and-swap hot reload | core | installed → resolved → enabled:loading → registering → ready → degraded → quarantined → disabled → uninstalled. Hot reload: spawn new version side-by-side → shadow-register → atomic registry flip for NEW invocations → old instance drains (30s deadline) → deregister; rollback on any failure — upgrades are transactional. `$PLUGIN_DATA` and `host.state.kv` are keyed by plugin id (not version) and persist; plugins implement `onUpgrade(fromVersion)`. |
| Env-manager integration | core | `lun plugin install <ref> \| list \| info \| enable \| disable \| pin \| update \| remove \| grants <id> \| logs <id> \| dev link <path>`. Lockfile records exact version + sha256 + signature + grant-set hash (grant changes are detectable). Per-repo isolation: the same plugin can run v1.2 in repo A and v2.0 in repo B with zero shared state. Disable atomically removes all contributions (tools vanish, panels unmount, subscriptions cancel). |
| Trust tiers + signing | important | official > verified-publisher > community > local-dev. Ed25519 (minisign-style; optional sigstore keyless) verified at install AND every load. Tier sets a capability CEILING the PDP enforces regardless of grants (community plugins can't get `exec` or out-of-data fs.write without explicit per-repo override); community default runtime = WASM. Badges in the UI; recorded in audit. |
| SDKs + dev mode | important | `@lunaris/plugin-sdk` (TS), `lunaris-plugin` (Python), WASI component world (`lunaris:plugin@2.x`) — typed decorators per extension point + typed host client. `lun plugin scaffold --runtime=node`; `lun plugin dev link` with file-watch hot reload (auto local-dev tier); conformance test kit (handshake, descriptor consistency, deadlines, graceful drain) required before registry publish. |
| Sandboxed UI panels | important | Static bundles served by the UI server in sandboxed iframes (strict CSP, no direct network); postMessage bridge exposes a restricted read API; any mutation goes through `host.tools.invoke` and therefore the PDP. Mount targets: sidebar tab, tool-result renderer, settings section. |
| Observability + metering | important | Per-invocation OTel spans tagged `{pluginId, version, extensionPoint}`; cgroup/rusage resource metering plus brokered accounting (tokens, network bytes, exec count, proposal accept rate). The optimizer flags plugins whose hooks add latency without improving success, suggests disabling, and tunes router-hint weights. |
| Health + quarantine | important | Liveness ping (10s), timeout-rate tracking, policy-violation counters. Threshold breach → automatic quarantine: process killed, contributions deregistered, `plugin.quarantined` event, UI badge; the tool router returns typed `tool_unavailable` errors agents plan around — never mid-run consent prompts. Release is manual or via successful upgrade. |
| Host-API versioning | important | Handshake advertises hostApi; incompatible ranges fail to load with an actionable error ("requires ^3.0, daemon provides 2.4"). Deprecations keep working within a major and emit warnings. |
| Inter-plugin services | nice-to-have | Manifest-exported typed services, dependency-resolved at install, called only via `host.services.call` (capability-checked, deadline-bounded, metered). Cycles rejected; dependency quarantine propagates typed `service_unavailable`. |
| Bundled capability packs | nice-to-have | Plugins may bundle skills and MCP server defs, registered under the plugin's namespace, sharing its trust tier and lifecycle; bundled MCP servers launch inside the owning plugin's sandbox profile. |

### Architecture notes

- Components in lunarisd: PluginManager (lifecycle), SandboxLauncher (per-OS profile from grant set), PluginSupervisor (spawn/ping/backoff/breaker), Broker (capability → PDP → quota → execute → audit), ContributionRegistry (atomic shadow-register/flip), HotReloadCoordinator, Meter.
- On-disk per repo: `.lunaris/capabilities/plugins/<id>/{<version>/ (immutable package), data/, grants.json, config.json}`; lockfile pins in `lock/lunaris.lock`.
- Every plugin→host request carries callId lineage so spans nest under the originating agent task for cost attribution.

### Integration points

- **PDP:** extends from agent tool calls to arbitrary plugin code without changing the decision model (per-plugin principals, trust-tier ceilings).
- **Orchestrator:** contributed tools/roles via the registry; lifecycle hooks intercept the agent loop.
- **Memory:** extractor/retriever stages; `host.memory.propose` feeds the curation gate with provenance + confidence.
- **ModelGateway:** provider.adapters register new backends; plugin model usage is routed, metered, budget-capped.
- **UI:** consent screens with grant diffs, config forms from configSchema, health/trust badges, RPC inspector, quarantine controls.

---

## 13. Harness Lifecycle — Self-Upgrade, Schema Migration & Rollback

### Overview

Lets the harness upgrade itself safely while multi-hour unattended runs are in flight, migrate its SQLite stores and committed config formats forward and backward, and tolerate version skew between a repo's committed artifacts and the harness installed on any machine. Four pillars: explicit schema versioning on every persistent artifact; an embedded, journaled, expand/contract migration framework with automatic pre-migration backups; side-by-side (A/B slot) binary installs with drain / checkpoint-and-resume / defer semantics for live runs; and health-gated activation with one-command rollback. Optimizer-generated config is version-stamped, revalidated on upgrade, and quarantined rather than silently broken.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Universal artifact versioning | core | Every SQLite store: `PRAGMA user_version` + `_meta` (schema_version, created_with, last_migrated_with) + `_migrations` journal. Config files carry `schema`/`min_harness`/`written_by`; lockfile `lockfile_version`; checkpoints a `checkpoint_schema` header; IPC a negotiated `proto` integer. Each release ships a compatibility matrix (read range / write version / migrate-from min per artifact kind); capability flags preferred over raw semver comparisons. |
| Embedded migration framework | core | Ordered, checksummed steps compiled into the binary (`migrations/<store>/NNNN_desc.{sql,code}`), recorded per store with checksum verification (edited history aborts). `lun migrate --plan` dry-runs per-store chains with duration/disk estimates; `--project`/`--all-projects` scope. Lazy by default (store migrated when the new daemon first opens it), eager mode available. |
| Expand/contract discipline | core | Additive "expand" ships first; destructive "contract" only after a settle window (default 72h healthy, or `lun migrate --finalize`). Consequence: version N−1 can still READ an expanded store — instant rollback and mixed-version operation are safe. Release tooling rejects mixed expand+contract steps. |
| Pre-migration backups + restore | core | SQLite Online Backup → `.lunaris/state/backups/<store>/<ts>-v<from>-to-v<to>.db.zst`, integrity-checked, audit-recorded. Config files get .bak + diff. Retention: last K per store (default 5) + last per minor line. `lun backup list\|restore <store> [--at <ts>]`. Scheduled backups for graph.db independent of upgrades (months of irreplaceable memory). |
| Shadow-copy migration for large stores | important | Stores > 256MB (graph.db, event indexes): migrate into `<store>.next.db` with batched row copy while live stays readable, WAL-tail the delta, sub-second quiesce, atomic rename. Crash mid-copy discards `.next.db`. Small stores migrate in-place transactionally. |
| Config migrators with comment preservation | core | Pure-function chains (`migrate_v1_to_v2(doc)`) on lossless document models (toml_edit/ruamel-style) so comments and formatting survive — these files live in git. Committed files are never auto-migrated silently: the migration is proposed as a diff (CLI prompt or UI card) and applied on approval. Lockfiles regenerate deterministically. |
| A/B slots + signed releases | core | `~/.lunaris/versions/<semver>/` with a `current` symlink; previous slot always retained. `lun self-update`: download → verify sigstore/minisign signature + SHA-256 against the signed manifest → unpack → self-test (binary boots, opens a scratch store, loads every migration chain) → flip. Channels stable/beta/nightly; `--pin 0.5.2` and org pinning prevent surprise upgrades mid-campaign. The release manifest carries machine-readable `breaking[]` and `migrations{}` summaries the UI shows pre-confirm. |
| Drain / checkpoint / defer for live runs | core | lunarisd broadcasts prepare-for-upgrade; per-run policy mode: DRAIN (continue to the next natural checkpoint, bounded by a deadline, default 10 min); CHECKPOINT-AND-RESUME (immediate checkpoint, resume under the new binary, timeline event "resumed under 0.5.2 from checkpoint seq 41"); DEFER (criticality-flagged runs pinned to the old slot, which keeps running side-by-side until they finish; new runs route to the new version). Defaults set in `policy.yaml` per run-priority class. |
| Versioned checkpoint format | core | `.lunaris/state/runs/<run_id>/<seq>.ckpt`: self-describing header + schema-evolution-friendly payload (protobuf/CBOR, unknown fields preserved). CI-enforced guarantee: version N resumes N−1 and N−2 checkpoints; resuming a NEWER checkpoint is refused with a pointer to the writing version. Checkpoint at every subagent completion + every M minutes — daemon death during upgrade loses at most one task step. |
| IPC protocol negotiation | important | Every connection opens with `hello{proto, harness, capabilities[]}`; peers pick the max mutual proto or fail with a structured `E_VERSION_SKEW` the UI renders actionably ("Daemon is 0.5.1, UI is 0.6.0"). HTTP API versioned `/v1`, `/v2` with N−1 support. |
| One-command + auto rollback | core | `lun self-update --rollback` flips the symlink; because contract hasn't run, the old binary reads expanded schemas directly — no restore needed in the common case. If contract HAS finalized: restore from backups with a clear data-window warning, plus event-replay rebuild of derived stores. Auto-rollback: post-flip canary (daemon boots, opens every store of every project, completes a no-op e2e task, reaches each provider); 3 consecutive failures → automatic revert + incident + notification. |
| Repo-artifact skew policy | core | Machine older than committed artifacts: strict mode (default) refuses with the minimum version named and `lun self-update` offered; lenient mode (`compat = "lenient"`) parses known fields if `min_harness` is satisfied. An older harness NEVER rewrites a newer lockfile (read-only; install/update refused) — no lockfile ping-pong in git. Newer local stores open read-only or refuse, never half-migrate downward. `lun verify --frozen` gives CI a hard pass/fail. |
| Upgrade safety for optimizer configs | important | Optimizer artifacts stamped with `written_by_version` + generation + parent hash; revalidated against the new schemas on upgrade; incompatible ones moved to `.lunaris/state/quarantine/` with a reason file and the shipped default takes over until regenerated — never silently broken. The optimizer is suspended from drain-start through a post-upgrade cool-down (default 24h) so regressions attribute to the version change; all metrics carry `harness_version`. |
| Doctor + UI System page | important | `lun doctor` adds: binary version/channel/pin, per-project store-version table, pending migration plans, backup freshness, quarantined configs, repo skew. Scriptable exit codes. UI System page: changelog + breaking list, one-click upgrade with live drain monitor ("3 draining, 1 checkpointing, 1 deferred on v0.5.1, ETA 4m"), canary results, backup browser, rollback button. |
| Migration corpus CI | important | Golden corpus of databases/configs from every released minor. Gates per release: upgrade-from-every-ancestor passes integrity; N−1 binary opens every store post-expand; checkpoint resume matrix N−2/N−1→N passes on recorded runs; fuzzed lenient parsing loses nothing; journal replay idempotent; contract steps reference their expand release. |
| Event-sourced rebuild | nice-to-have | The event spine is the source of truth for run history; board projections and rollups are rebuildable by replay (`lun rebuild <store> --from-events`) — converting several failed-migration classes from "restore backup, lose data" to "replay, lose nothing". |
| Fleet convergence | nice-to-have | `lun fleet status` aggregates doctor reports; org policy can declare a minimum harness version per repo; staged channel rollout with reverted-release markers that block automatic re-upgrade to a bad version. |

### Integration points

- **aienv:** package resolution checks `harness = ">=X"` ranges and capability flags against the running slot's matrix; the env manager invokes config migrators on load.
- **Orchestrator:** implements prepare-for-upgrade, checkpoint-at-boundary, resume-from-checkpoint.
- **Memory:** primary consumer of shadow-copy migration and scheduled backups.
- **Optimizer:** suspension window + artifact revalidation/quarantine.
- **UI/CI:** System page, version-skew banners, `lun verify --frozen` in pipelines.

---

## 14. Project Lifecycle & State Portability

### Overview

Makes a project's entire AI environment — memory graph, analytics, routing history, optimizer policies, golden tasks, board state — durable, portable, shareable, and disposable. A formal state taxonomy and a mandatory Exporter/Importer/Merger contract for every subsystem underpin scheduled whole-project snapshots, one-command clone-to-new-machine hydration, team sync with layered (team vs personal) memory, safe archival/deletion with GC of the global store and keychain namespaces, a two-level identity model that survives renames/moves/forks, and monorepo support. Without this, `git clone` on a second machine yields an amnesiac project — all the per-project intelligence is gitignored.

### Features

| Feature | Priority | Notes |
|---|---|---|
| State taxonomy + export contract | core | Five tiers: **T0** committed (lunaris.toml, lockfile, policy, memory/export, goldens — already in git); **T1** portable derived state (graph.db, analytics, routing history, optimizer state, board — syncable/bundleable); **T2** machine-local caches (CAS blobs, model caches — never synced, always rebuildable); **T3** secrets (keychain — never exported, referenced by name only); **T4** personal (per-developer memory overlay, raw personal analytics — private by default). Every subsystem MUST implement: `export(scope) → stream`, `import(stream, mode=replace\|merge)`, `merge(local, remote) → merged + conflicts[]`, `gc_roots()`, `fingerprint()`. Lifecycle features are generic drivers over this contract — a new subsystem is automatically backupable/syncable. |
| Project identity v2 | core | Two levels. `project_id` (ULID, committed in lunaris.toml) names the project *lineage* and travels with every clone/fork — it keys registry entries and CAS refcounts (never secrets). `instance_id` = blake3(project_id ‖ machine_id ‖ checkout_salt), minted on first run, stored gitignored in `.lunaris/state/instance.json` — it keys the orchestrator singleton lease, daemons, ports, run state, and the keychain secret namespace (§2.6). Two clones of one repo: same project_id, different instance_ids → no lock collision. |
| Rename/move/fork reconciliation | core | `instance.json` stores a repo fingerprint (canonical remote URL + root-commit SHA + path). On startup, mismatches trigger `lun doctor identity`: path change → silent relocate; remote rename → confirm + update; diverged history → fork choice: continue lineage (keep project_id, mark divergence) or fork lineage (new project_id with `forked_from` + fork point, T1 state deep-copied or shared-by-snapshot). Fork chains recorded in the registry for cross-fork provenance. |
| Bundle export/import (`.aihbundle`) | core | Deterministic zstd(tar): `META/manifest.json` (format_version, project_id, versions, scope, parents), `META/integrity.json` (BLAKE3 merkle root), `META/secrets.manifest.json` (key NAMES and purposes only — never values; drives rebind prompts on import), `STATE/<subsystem>/` exporter streams (memory entities/relations JSONL with provenance + logical clocks — communities excluded, always recomputed; analytics Parquet; optimizer policies + routing priors; goldens; board), `ENV/` manifest+lock copies, `CAS/` referenced blobs. Optional age encryption with recipients. `lun export [--scope …] [--audience team\|personal\|public]`; `lun import <bundle> [--mode replace\|merge] [--dry-run]` — always takes a pre-import undo snapshot, ends with keychain rebind prompts. |
| New-machine bootstrap (`lun adopt`) | core | After clone: read project_id → mint instance_id → `lun install` from the lockfile → hydrate T1 from the best source in order: configured sync remote → provided bundle → reachable backup target → cold start with committed seed (memory/export + goldens). Finishes with doctor checks (missing secrets listed with prompts, provider keys validated, orchestrator smoke test). Target: clone-to-productive in one command, under two minutes excluding downloads. |
| Scheduled snapshots (backupd) | core | Whole-project point-in-time snapshots across ALL subsystems atomically (quiesce or WAL-consistent `.backup` per store). Full + incremental via FastCDC content-defined chunking into the CAS. Configured in `lunaris.toml [lifecycle.backup]`: schedule (default hourly incremental, daily full), targets (local, S3-compatible, or a git ref), GFS retention (24h/30d/12w/12m). Automatic pre-op snapshots before every destructive operation: restore, import-replace, memory prune, optimizer rollout, archive, delete. |
| Point-in-time + selective restore | core | `lun restore --at <ts\|snapshot-id> [--only memory,optimizer,…] [--dry-run]`: stop orchestrator → undo snapshot → materialize from CAS → per-subsystem import → merkle verification → restart. Selective restore rolls back just the optimizer after a bad cycle while keeping new memories. Every restore is itself undoable. |
| Restore drills | important | Weekly job restores the latest snapshot into a throwaway sandbox instance, runs integrity checks + a golden smoke suite, reports pass/fail. A never-restored backup is badged *unverified*. Catches silent corruption and exporter drift before a real disaster. |
| State sync engine (statepacks) | core | Continuous multi-machine/multi-developer T1 sync: local op journal (`op_id ULID, actor, instance_id, hybrid logical clock, subsystem, payload`), exchanged as packed segments through pluggable transports: **git-ref** (`refs/lunaris/state` on the existing origin — zero extra infrastructure), S3-compatible prefix, or a sync server. Pull-merge-push with per-subsystem reducers; `lun sync status\|push\|pull`; offline-first, converges on reconnect. |
| Per-subsystem merge semantics | important | MEMORY: OR-Set entities/relations keyed by semantic ids, per-assertion LWW by HLC, confidence = max, provenance union, curation tombstones win within a decay window (one developer's pruning isn't undone by a stale sync), communities never synced — recomputed. ANALYTICS: append + dedupe by event_id, rollups recomputed. OPTIMIZER: immutable versioned policies; concurrent heads resolved by golden-eval score (loser kept as a named variant). ROUTING PRIORS: statistic sums. GOLDENS: id union. BOARD: field LWW + furthest-progress status with conflict flag. Unresolvable → UI conflict inbox, never silently dropped. |
| Layered memory: team vs personal | core | Per-assertion `layer` tags in one graph.db: TEAM (synced — shared project knowledge) and PERSONAL (local-only, optionally synced to that developer's own remote). Reads merge with personal shadowing team; every assertion carries layer + author, so the orchestrator weights trust by author and layer. Promotion: `lun memory promote <ids>` or an auto-nomination queue, gated by `lunaris.toml [team.memory] promotion = auto\|any-member\|owner-review`. Demotions/prunes sync as attributed tombstones. |
| Redaction + privacy filters | important | T3 is structurally impossible to export; personal-layer memory and raw per-developer analytics are excluded from team statepacks by default (team gets pre-aggregated rollups, not raw transcripts, unless opted in); regex/classifier PII + credential scrubbing with a pre-share review diff. `--audience team\|personal\|public` selects the profile. |
| Archival (`lun archive`) | core | Stop orchestrator + subagents → cancel schedules → flush sync journal → final verified bundle to all targets → registry status=archived → release leases → optionally compress-and-evict local state → CAS working refs decremented (archive refs retained). Keychain entries RETAINED (reversible). `lun unarchive` restores; archived projects grey out in the picker with one-click restore. |
| Deletion with tombstones (`lun delete`) | core | Archive-first: final bundle → `~/.lunaris/trash/<project_id>/` + registry tombstone (TTL 30d). `lun undelete` during grace. At expiry (or `--purge --yes`): keychain namespace enumerated, names recorded, entries deleted; CAS refs released; deletion marker pushed to sync remotes ("project deleted by <actor>" instead of silent desync); schedules/UI/streams removed. Origin-level purge requires `--origin` and warns about other live instances. |
| Global store GC (`lun gc`) | core | `~/.lunaris/store/` gains `store-refs.db` (blob_hash → {(project_id, ref_kind ∈ env-artifact, snapshot-chunk, memory-blob, archive)}). Weekly mark-and-sweep from all registered roots + retained snapshots; sweeps zero-ref blobs past a 7-day grace; reports reclaimed bytes per project; orphan detection with adopt-or-release. Never runs while a restore/export is in flight (advisory lock). |
| Monorepo workspaces | important | `lunaris.toml [workspace] members = ["packages/*", …]`; member manifests inherit root and override; member lock entries fold into the root lockfile. Member ids derive from project_id + stable slug with a path-remap table (moving `packages/foo` → `libs/foo` preserves identity and memory). One `.lunaris/` at the root with state partitioned per member + a shared root partition (cross-member entities). Orchestration: `single` (root orchestrator, member-scoped subagents) or `federated` (per-member sub-orchestrators, leases keyed instance_id+slug). All lifecycle verbs accept `--member <slug>`. |
| Lifecycle UI tab | important | Snapshot timeline (full/incremental/pre-op markers, drill-verified badges, restore with dry-run diff), sync panel (ahead/behind, presence, conflict inbox with side-by-side resolution), team panel (members, promotion review queue, redaction profile), bundle wizard, identity panel (lineage/fork graph, reconciliation prompts), archive/delete with grace countdown. Global Storage settings: CAS size per project, GC schedule, trash, backup-target credentials. |
| Lifecycle audit + events | important | Every operation (snapshot, restore, import, sync, merge conflict, promotion, archive, delete, GC, identity reconciliation) emits a spine event with actor, instance, scope, before/after fingerprints, bytes moved. The optimizer correlates restores with regressions and re-verification failures. |
| Format versioning | important | Bundle/statepack manifests carry format + per-subsystem schema versions; importers run up-migration chains and refuse newer-than-supported with a clear "upgrade harness" error. Sync peers negotiate the minimum common journal schema. A 12-month-old archive of a deleted project remains restorable. |
| Clone templates | nice-to-have | `lun export --as-template` strips project-specific memory/analytics but keeps env manifest, prompt baselines, routing priors, golden skeletons; `lun init --from-template <ref>` starts a new project (fresh project_id) pre-tuned — propagating hard-won harness tuning without leaking the old repo's knowledge. |

### Integration points

- **aienv:** `adopt` replays the lockfile before state hydration; monorepo member resolution extends the manifest loader; templates reuse manifest/lock formats.
- **Memory:** implements the merge contract; layer/author/HLC columns; communities are derived state.
- **Orchestrator:** lease rekeyed to instance_id; quiesced around snapshot/restore/archive; conflict-inbox items can be assigned to it for AI-mediated resolution.
- **Optimizer:** policies are sync citizens resolved by eval score; pre-op snapshots give it a safe rollback primitive.
- **SecretBroker:** keychain namespaces keyed by the machine-local instance_id (§2.6), never the committed project_id; rebind prompts from `secrets.manifest.json`; deletion purges the namespace after grace.

---

## 15. Identity, Auth & Distributed Deployment ("lunaris-id")

### Overview

Removes the single-machine, single-user assumption without sacrificing zero-config local UX. The harness splits into a control plane (identity, RBAC, leases, audit, secret vault — an embedded lunarisd module by default, externalized to a standalone lunaris-control service only in fleet mode, never a second per-machine daemon; §2.1) and data-plane daemons that run agents headlessly on any machine and enroll via one-time join tokens + mTLS. Every actor — human, node, agent run, service — becomes a first-class principal, making "approver" and "signed UI actions" cryptographically meaningful. The per-machine orchestrator lock is replaced by a fenced, TTL-leased one-orchestrator-per-repo invariant that holds across machines. The UI becomes a properly secured multi-user web app.

### Features

| Feature | Priority | Notes |
|---|---|---|
| Headless daemon mode | core | `lun daemon start --headless --advertise gpu=1,ram=128g`. Listen: unix socket (default, loopback-equivalent) or `tcp://HOST:7177` (refuses non-loopback binds without TLS). All execution lives on the daemon's machine; the UI is a thin client. `lun connect https://beefy.tailnet:7177 --join-token <tok>`. Live subagent views stream over multiplexed gRPC/WebSocket — laptop UI watches the GPU box in real time. |
| Embedded vs external control plane | core | lunaris-control owns identity, RBAC, leases, audit, fleet registry, vault. EMBEDDED (default): compiled into lunarisd, SQLite-backed, zero config — today's single-box UX byte-for-byte. EXTERNAL (fleet): standalone process with Postgres; `lun control migrate --to postgres://…` promotes. Daemons cache RBAC 60s; control-plane unreachable → privileged ops fail CLOSED, read-only fail OPEN. |
| Node enrollment + internal PKI | core | Ed25519 node keypair at first boot (`~/.lunaris/node_key`, 0600); node_id = key fingerprint. Owner mints one-time join tokens (`lun fleet join-token create --ttl 1h`); built-in CA issues 30-day node certs, auto-renewed at 2/3 life. All daemon↔control and daemon↔daemon traffic is mTLS. `lun fleet revoke <node>` pushes a revocation list polled every 30s; revoked nodes checkpoint-and-kill their agents. |
| Principal model | core | One table: `usr_*` (humans), `node_*` (daemons), `agt_*` (a specific orchestrator/subagent RUN), `svc_*` (CI/automation tokens). Every API call, lease, approval, memory write, and audit record carries a principal_id. Agent principals are minted per run and parented to the initiating human/schedule — cost and blame chain: subagent → run → user. |
| Local-first auth + OIDC | core | Built-in store: argon2id + optional TOTP, WebAuthn/passkeys preferred. First boot single-box: implicit local owner via unix-socket peer credentials (SO_PEERCRED/getpeereid) — no login screen until a second user or remote listener exists. Teams: OIDC (Google/GitHub/Okta/Entra) with group→role mapping. CLI: device-code flow (`lun login`). |
| Session + token lifecycle | core | UI sessions: httpOnly Secure SameSite=Strict cookies, 15-min sliding window in a 12h absolute lifetime. API/CLI: PASETO v4 access tokens (15 min) + one-time rotating refresh tokens with family theft detection (reuse revokes the family). Agent tokens: run-scoped, attenuated (below). Signing keys rotate on 90-day schedule with 7-day overlap; `lun auth rotate-keys`. Users can list/kill their own sessions; owners anyone's. |
| Project-scoped RBAC | core | Roles per project and global: owner, maintainer, operator, viewer, auditor. Capability matrix for dangerous powers: kill_switch (operator+), resume_after_kill (maintainer+), approve_queue_item (operator+, never the requesting principal), change_autonomy_level (maintainer+), secrets reveal/rotate/write (owner + step-up), provider keys (owner + step-up), memory.prune/graph.edit (maintainer+), optimizer.promote (maintainer+), fleet ops (owner). Evaluated at the control plane; capability claims re-verified at the daemon (defense in depth). |
| Step-up auth | important | Secret reveal, provider-key writes, autonomy ceiling changes, optimizer promotion, node revocation: fresh WebAuthn/TOTP assertion within 5 minutes, challenge bound to a hash of the action payload. DELIBERATE EXCEPTION: the kill switch needs only a valid session — emergencies are low-friction; *resuming* requires elevated role + step-up. |
| Agent identity + attenuated tokens | core | At run start the daemon mints a biscuit-style attenuable token: `{project_id, run_id, lease_epoch, caps: [fs.write:/repo, net.allowlist, provider:<ids>, memory.write, spawn]}`. Spawning a subagent ATTENUATES (never escalates): a tester gets fs.read + exec:test-runner only; a researcher gets net + no fs.write. Verified offline (public key, no control-plane round trip per call). Expires at run end or lease loss. Turns the env boundary into an enforced credential, not a convention. |
| Distributed orchestrator lease with fencing | core | Replaces the lock file. Repo identity = project_id. Lease: `{project_id, holder agt_*, node_id, epoch (monotonic u64), heartbeat 15s, ttl 45s}`; 3 missed beats → expirable; epoch increments on acquisition. FENCING: every side-effecting write (pushes, memory mutations, optimizer state, approval resolutions) is stamped with the epoch; stale epochs are rejected (409 LEASE_FENCED) — a paused-then-resumed zombie on machine A cannot clobber machine B's work. `lun orchestrator takeover <project> [--force]` (maintainer+): old holder checkpoints before the new one starts. UI shows holder, node, epoch, lease health. |
| Git-anchored advisory lease | nice-to-have | Disconnected fallback for two machines sharing only a git remote: signed lease blob CAS'd to `refs/lunaris/lease/<project_id>` — a competing push fails fast and surfaces "repo is being operated by node_X since 14:02" instead of silent divergence. Explicitly advisory; the recommended fix is joining one control plane. |
| Fleet registry + placement | important | Nodes register {os/arch, cpu, ram, gpus, installed local providers + pulled Ollama models, disk, addresses, version}. Routing gains a placement dimension: send local-inference tasks to the node that has the 70B model pulled; browser automation to the node with a display. Placement outcomes become an optimizer dimension ("tests run 4× faster on node_gpu1"). UI fleet page: health, running agents, cert expiry. |
| Browser security | core | Explicit `allowed_origins` allowlist (default: the daemon's own UI origin); absent/foreign Origin on state-changing routes → 403 + audit. CSRF: SameSite=Strict + double-submit header. No tokens in localStorage — browser auth is httpOnly cookies only. WebSocket auth via one-time 30s tickets fetched over authenticated REST. CSP with no third-party scripts, frame-ancestors 'none'. TLS mandatory on any non-loopback bind; HSTS when on. |
| Signed actions + tamper-evident audit | core | Every control action (kill, resume, approve/reject, autonomy change, secret op, lease takeover, login, step-up) = `{action_id, principal_id, session_id, action_type, payload_hash, prev_record_hash, ts, sig}` — WebAuthn-bound where available, else control-plane-signed (attestation_level device\|server). Hash-chained with daily Merkle roots written to DB + append-only file (optionally a git ref) — a compromised DB can't silently rewrite history. The optimizer consumes ONLY verified records as human-feedback signal. |
| Secret vault, node-scoped delivery | important | Provider keys live only in the control-plane vault (master key in OS keychain single-box; KMS/age-keyfile fleet). Daemons never store raw keys at rest: node-sealed copies or short-lived derived credentials fetched at task start. The browser NEVER receives secret material — settings show fingerprint/last4 with step-up-gated actions. Per-project scoping: a repo's env declares which provider keys it may use. |
| Multi-user presence + driver semantics | important | Multiple humans in one orchestrator chat; every message attributed to its principal (the orchestrator sees "alice: …", "bob: …" and disambiguates by role precedence). Presence indicators per subagent stream. Optional driver mode: one steering token, others read-only with request-control. Queue approvals: any operator+, never the requester. |
| Per-principal cost + quotas | important | Cost rolls up subagent → run → initiating user/service. Per-user and per-token budgets (daily/monthly), per-node concurrency limits; breach pauses new runs for that principal and notifies. |
| Emergency lockdown | important | `lun lockdown` (owner, or operator+ with two-person confirmation): freeze all leases, revoke all agent tokens, suspend service tokens, kill all runs on all nodes, disable non-owner logins. Per-principal revocation propagates ≤30s. Recovery requires owner + step-up. |
| Reachability helpers | nice-to-have | `lun tunnel <node>` (SSH local-forward); optional embedded tsnet listener (Tailscale TLS + tailnet ACLs under harness RBAC). No custom relay/NAT traversal in v1. |
| Auth-aware CLI | important | All verbs work against remote daemons via `lun context use <name>` (`~/.lunaris/contexts.toml`, kubeconfig-style; tokens in the OS keychain). `lun whoami`; `lun token create --as svc --project X --role operator --ttl 30d` for CI. |

### Architecture notes

- Ports: lunarisd API :7177 (gRPC/ConnectRPC over HTTP/2, TLS), control plane :7178; single-box keeps everything on the unix socket + localhost:7340 UI.
- Leases via a single CAS UPDATE in SQLite/Postgres (Kleppmann fencing-token pattern) — no etcd/ZooKeeper at this scale.
- Single-box mode is byte-for-byte today's UX; everything in this section is additive.

### Integration points

- **Orchestrator:** acquires/heartbeats the lease, stamps `lease_epoch` on every side-effecting call, handles `LEASE_FENCED` + revocation (checkpoint-and-exit).
- **Subagent spawner:** mints attenuated tokens from the env manifest's per-role max capability sets.
- **Approval queue / Optimizer:** signed records; requester ≠ approver; epoch-fenced optimizer writes; policy promotion is an audited maintainer+ capability.
- **Memory:** mutations carry epoch + writer principal (provenance edges: who asserted a fact); per-project memory readable only with a role on that project.
- **ModelGateway / Fleet:** provider keys vault-held with node-scoped delivery; routing consults the fleet registry for local-model placement.

---

## 16. Suggested Tech Stack (consolidated)

One deliberate decision is required up front: the daemon language. The sources split between Go/Rust (daemon, PDP, lifecycle) and TypeScript (orchestrator on an agent-SDK session model, ModelGateway, UI) with Python for the memory/graph pipeline. Recommended split below; see Open Questions for the trade-off.

### Core runtime

| Concern | Choice | Notes |
|---|---|---|
| lunarisd + project-host + PDP + lifecycle | **Go or Rust** | Single static binary; launchd/systemd units; solid unix-socket + process-supervision primitives; sub-ms compiled-rule PDP path via decision trees (AST analysis low-ms, §6); A/B slot installs (rustup/volta-style symlink flip). |
| Orchestrator + ModelGateway | **TypeScript/Node** | Built on the Claude Agent SDK session model (resumable sessions, tool loops) with hand-rolled thin provider adapters (control over quirks/error taxonomy beats SDK convenience; borrow LiteLLM / Vercel AI SDK translation tables, not their abstractions). ajv for all JSON Schema validation; zod internally. |
| Memory Service | **Python** | NetworkX + leidenalg/igraph (graspologic hierarchical_leiden) — same stack family as the existing graphify package; official MCP Python SDK for the memory MCP server. |
| lunaris-config | Go/Rust core + napi/pyo3 bindings | The only parser of harness state; one schemas/ package (JSON Schema 2020-12, optionally authored in CUE). |

### Storage & data

- **SQLite (WAL)** everywhere a transactional store is needed: memory graph.db (with **sqlite-vec** for vectors, FTS5 for lexical linking), board.db, automation.db, control.db. Online Backup API for hot snapshots; PRAGMA user_version for migrations.
- **JSONL segments + DuckDB** for the event spine and analytics (rebuildable index; columnar group-bys; reads SQLite and Parquet in one view). **Parquet + zstd** for cold compaction/export. **t-digest** sketches for mergeable latency percentiles.
- **ULID / UUIDv7** for all ids (time-ordered, sortable, double as stream cursors). **BLAKE3** for content addressing and hash chains. **FastCDC + zstd** for incremental snapshots (restic/borg-style dedupe into the CAS).
- **git**: worktrees for task isolation and eval sandboxes, bundles for snapshots, refs as zero-infra sync transport (`refs/lunaris/state`, pattern proven by git-bug/git-annex).
- Formats: TOML for human manifests (toml_edit/tomlkit for comment-preserving migration), YAML for policy-style files (eemeli/yaml for comment-preserving optimizer diffs), JSON for journals, protobuf/CBOR for checkpoints (field-numbered, default-tolerant evolution).

### Security & policy

- Policy engine: **Cedar** (deny-overrides semantics map cleanly) or CEL; shell AST via **mvdan/sh** or tree-sitter-bash.
- Sandboxing: Docker/Podman (optional gVisor); **bubblewrap + Landlock + seccomp + cgroups v2** (Linux), **sandbox-exec/Seatbelt** (macOS); **wasmtime + WASI Preview 2** for community plugins. Egress: purpose-built CONNECT proxy with SNI allowlisting, pinned DNS.
- Secrets: OS keychain (Keychain/DPAPI/libsecret) via keyring abstractions; **age** for headless fallback and bundle encryption; libsodium sealed boxes for node-scoped delivery.
- Identity: **PASETO v4** access tokens; **biscuit-auth** for attenuable agent capability tokens; argon2id; **SimpleWebAuthn** passkeys; openid-client (OIDC); minimal self-rolled Ed25519 CA for node certs; **minisign/sigstore** for release + package signing.

### Interfaces & protocols

- JSON-RPC 2.0 over unix sockets for the local control plane (debuggable; same family as MCP/LSP — also the plugin host protocol); gRPC/ConnectRPC over HTTP/2 for fleet mode; WebSocket (ndjson, per-topic seq + gap replay) for live UI; SSE fallback; REST for mutations.
- OpenTelemetry GenAI semantic conventions + optional OTLP export; CloudEvents-compatible envelope naming.
- UI: **React 19 + TypeScript + Vite**, TanStack Router/Query, Zustand, Tailwind + shadcn/ui, Monaco, xterm.js, React Flow + ELK, sigma.js/graphology (WebGL KG), ECharts, Virtuoso. Optional **Tauri 2.x** native shell (tray, notifications, keychain, deep links) over Electron.
- Scheduling/parsing: croniter/cron-parser; CEL + JMESPath for trigger rules; Jinja2/eta (strict-undefined) for goal templates; cloudflared/smee helper for webhook ingress.
- Embeddings/local: **Ollama** (nomic-embed-text default; keep_alive tuning); OpenRouter as zero-config meta-fallback; PubGrub-style semver resolution for the capability manager; OCI/ORAS registry backend for plugin/capability packages.

---

## 17. Build Roadmap

Phasing is by dependency: the event spine, manifest, and gateway underpin everything; memory/policy/analytics need real traffic; the optimizer needs months of ledger data to be useful; fleet/multi-user is additive at the end.

### Phase 1 — MVP: a working autonomous loop on one machine

> Goal: submit a goal in the UI, watch subagents complete it unattended in worktrees, with every event logged and reproducible installs.

- **lunarisd skeleton:** ProjectSupervisor + project-host, unix-socket JSON-RPC, crash-only restarts. ConfigD (validate/commit/journal — canary slots can stub), SecretBroker (keychain + leases), EventBus writing JSONL segments + a minimal DuckDB index. Taxonomy v1 (core.yaml, validation at the edges).
- **aienv core:** `lunaris.toml` + lockfile + `lun init/install/update/doctor`; skills + MCP capability types; content-addressed store; isolation cells (process-mode MCP, scrubbed env, keychain namespaces); basic devenv (reuse an existing devcontainer + probe fallback, `lun devenv build|verify`, §3). Profiles/registry deferred.
- **Orchestrator v1:** goal contracts, planner → DAG, board.db, SOLO/PIPELINE/FANOUT patterns, built-in roles (coder/reviewer/tester/researcher/summarizer), context packer, ResultEnvelopes, journal + checkpoint resume, write-ahead intent journal + idempotency keys for side-effecting tool calls (§6 failure-mode matrix), worktree isolation + integrator, escalation inbox (basic).
- **ModelGateway:** unified API + streaming/tool/structured-output normalization for **two providers (Anthropic + Ollama)**; routing.yaml resolution; fallback chains; `llm.usage` events; L3 provider-native prompt caching; transactional BudgetLedger (atomic reserve/settle/refund) enforcing budgets.yaml hard stops (degrade mode later).
- **Mission Control v1:** project rail, orchestrator chat, live agents view, plan board, settings (providers/keys), WS event stream with gap replay. Served at localhost:7340; implicit local owner via socket peer credentials, plus minimal auth (local password/passkey) — the daemon refuses any non-loopback bind without TLS + auth.
- **Safety floor:** git safety net (branches/worktrees/checkpoints/protected-branch hard floors), basic allow/deny command rules, kill/pause, per-task + per-day budget caps. Full PDP/sandbox in Phase 2.
- `lun doctor` (layout + config conformance) and `lun migrate` (greenfield, so trivial — but the journal/version fields ship from day one).

### Phase 2 — Memory, policy, analytics

> Goal: the harness gets a memory worth trusting (advisorily), runs safely unattended overnight, and you can see everything.

- **Memory:** Memory Service with ingestion pipeline, retention gate, three record types, local/global retrieval, briefs with the verify-before-trust contract, feedback loop, decay/reinforcement, contradiction machine, MCP server + `lun memory` CLI, memory tab + conflict inbox, graphify import/export.
- **Autonomy & safety, full:** PDP with layered policy + AST command matching + risk classes, OS sandboxes + egress proxy, irreversible-action async approval queue with notifications, structured denial feedback, anomaly watchdog, secret broker-proxy mode + redaction layer, taint tracking for untrusted content with stricter tainted-context PDP profiles (part of the safety floor).
- **Observability, full:** trace model + forensics/replay, rollups + scorecards, dashboards (overview, task explorer, cost explorer, model comparison, tool health), regression detection with config_rev attribution, pricing table, retention/redaction controls, OTLP export.
- **Gateway expansion:** remaining adapters (OpenAI, DeepSeek, Gemini, OpenRouter, openai-compatible), model catalog, health monitoring, L1/L2 caching, embeddings API, degrade-on-soft-budget.
- **devenv, full:** devcontainer / Nix flake / Dockerfile provisioners, content-hashed environment cache, `lun devenv shell` (probe fallback and devcontainer reuse ship in Phase 1).
- Orchestrator: remaining patterns (ADVERSARIAL, RACE, MAP-REDUCE), watchdog, analytics-informed routing priors, dry-run mode, user-defined roles.

### Phase 3 — Self-optimization, plugins, automation

> Goal: the harness improves itself with statistical discipline, accepts work from the outside world, and is extensible.

- **Optimizer (v1 scope = outcome ledger + routing bandit + propose-only suggestions):** outcome ledger joins, success-signal resolver, pattern analyzer, routing bandit, proposal generator with risk rubric + approval cards (everything propose-only in v1), learnings report, prompt learned-guidance and memory threshold tuning as proposals. Deferred past v1: golden suite + harvesting, eval runner with paired A/B + non-inferiority gating, ConfigD canary integration, auto-rollback monitoring — the full golden-eval machinery ships once ledger volume justifies it.
- **Autonomy intake:** goal queue + dispatcher (interactive submit becomes a P0 enqueue), schedule manager + system-job unification, goal templates, webhook gateway + trigger rules (CEL/JMESPath), GitHub adapter with canned rules, pollers, dead-letter queue, shadow mode, automation tab + CLI.
- **Plugin system (v1 scope = tools + MCP server defs only):** manifest, host process + JSON-RPC protocol, brokered host API under the PDP, grants + consent + OS sandboxing (WASM tier first for community), lifecycle + hot reload, TS/Python SDKs + scaffold/dev-link, signing + trust tiers. UI panels, inter-plugin services, and the remaining extension points are deferred past v1.
- **Lifecycle (self-upgrade):** artifact versioning + migration framework + expand/contract discipline, A/B slots + signed releases, drain/checkpoint/defer, auto-rollback canary, skew policy + `lun verify --frozen`, migration corpus CI. (Ship the version fields in Phase 1; ship the machinery here, before the first painful schema change.)

### Phase 4 — Fleet, teams, portability

> Goal: more machines, more people, durable state.

- **lunaris-id:** control-plane split (embedded → external Postgres), node enrollment + mTLS, principals + RBAC + step-up, PASETO/biscuit tokens, fenced distributed orchestrator lease (replacing the local lock), browser hardening, signed audit chain, vault with node-scoped delivery, presence/driver semantics, per-principal budgets, lockdown, fleet registry + placement routing.
- **Project lifecycle & portability (v1 scope = snapshot/restore + export bundle):** export contract across all subsystems, identity v2 (instance_id + fork reconciliation), bundles + `lun adopt`, backupd + selective restore + restore drills, redaction profiles, archive/delete/GC, monorepo workspaces, lifecycle tab. Deferred past v1: state sync engine (git-ref transport first) + merge semantics + team/personal memory layers + promotion review.
- Global memory tier promotion pipeline; cross-project benchmarking and optimizer hints; clone templates; quiet hours; Sentry/monitoring adapters; Tauri shell polish.

---

## 18. Open Questions & Risks

1. **Resolved — agent dev-environment provisioning.** Now owned by the devenv subsystem (§3): `lunaris.toml [devenv]` declares a provisioner (devcontainer / Nix / Dockerfile / probe fallback), environments are content-hashed and consumed by subagent sandboxes, the integrator's test step, and the eval runner; provisioning failures are tagged `failure_class=infra`. Basic devenv lands in Phase 1, full provisioners in Phase 2.
2. **Offline/local-only mode is not coherent end-to-end.** Pieces exist (local routing tier, registry mirror, local embeddings), but nobody detects connectivity loss and flips a harness-wide state; the degraded-mode contract per subsystem (memory extraction/NLI checks, gate LLM scoring, optimizer judge, semantic cache) when only Ollama is reachable is unspecified — do in-flight tasks degrade or park? The failure-mode matrix (§6) now specifies the first-line per-subsystem degrades (park memory-extraction queues, skip NLI checks, disable optimizer judges, local-model-only routing); given Ollama is a headline requirement, a complete offline behavior table per subsystem is still needed.
3. **Implementation-language split.** Go/Rust daemon + TS orchestrator/gateway + Python memory is three runtimes, three sets of lunaris-config bindings, and a polyglot debugging story for a solo maintainer. Alternative: all-TypeScript (weaker sandbox/PDP latency story, but the Agent SDK, gateway, and UI already want TS, and Python survives only inside the Memory Service). Decide before Phase 1; the cost of switching later is highest for the daemon.
4. **Event-spine volume vs token streams.** If per-token deltas flow through the same spine as durable events, segment volume explodes; if they bypass it, the replay/scrubber guarantees weaken. Current design keeps transcripts as separate files with the spine carrying summaries — verify this split holds for the timeline scrubber and forensics requirements, and budget disk (hourly segments + blobs + transcripts can reach GBs/month per active project).
5. **Optimizer trust and sample sizes.** Most solo projects won't produce n ≥ 10–41 samples per (task_class, model) cell quickly; Wilson intervals and non-inferiority gates may keep the optimizer silent for months (acceptable) or push it toward judge-only signals (risky: judge drift, reward hacking against rubrics). The golden suite also costs real money nightly. Needs explicit minimum-data thresholds, a "cold project" mode, and honest ROI reporting before auto-adoption is enabled by default.
6. **Identity model tension.** Harness Core's committed `project_id` vs lifecycle's instance/fork model is reconciled here (project_id = lineage, instance_id = checkout), but edge cases remain: two checkouts of one repo on one machine sharing a synced team memory layer, shallow clones without the root commit for fingerprinting, and `project_id` collisions from repo templating (`lun init` from a copied repo). Define the reconciliation UX precisely before Phase 4 sync ships.
7. **Prompt-injection depth.** Taint tracking is now core and ships in the Phase 2 safety floor (§6), but research subagents fetch arbitrary web content into the same context that later authorizes tool calls. Until it ships, the real defenses are the egress allowlist, broker-held secrets, and irreversible-action queue — document this honestly as the threat model and keep L3 auto-approve classes minimal by default.
8. **Resolved — UI/remote security sequencing.** Phase 1 now ships minimal auth (local password/passkey; the daemon refuses any non-loopback bind without TLS + auth) plus the Origin-allowlist + WS-ticket middleware; full lunaris-id hardening (principals, RBAC, step-up) still lands in Phase 4.
9. **Monorepo support is large.** Nested manifests, member identity remapping, federated orchestration, and per-member lifecycle verbs touch nearly every subsystem. It is scheduled in Phase 4 but should be treated as a possible v2 cut if it threatens the core timeline.

An adversarial design review of this draft drove the resolutions above, plus the failure-mode matrix (§6), the transactional BudgetLedger (§2.7), the devenv subsystem (§3), and the softened replay/latency claims (§1).

---

## Appendix A — Reference File Examples

Concrete, normalized examples of every human-edited file. These are the canonical shapes coding agents should implement against; JSON Schemas for each live in `<install>/schemas/`.

### A.1 `lunaris.toml`

```toml
[project]
project_id     = "01J9ZK7Q4R8WX2M5T3N6B1C9DE"   # ULID, minted at `lun init`, committed; names the lineage
name           = "billing-service"
layout_version = 1
min_harness    = ">=0.4"
written_by     = "0.5.2"
# compat = "lenient"                              # opt-in: older harness parses known fields

[capabilities]
extends = ["python-api@1.2.0"]                    # profiles, ordered, later wins
inherit = { skills = "explicit", mcp = "none", plugins = "none" }

[capabilities.skills.pytest-runner]
version = "^2.1"                                  # registry source implied
[capabilities.skills.deploy-helper]
source = { git = "git@github.com:org/deploy-skill", rev = "v2.1.0" }   # tag pin; lockfile resolves any ref to an exact commit SHA + sha256
[capabilities.skills.scratch]
source = { path = "./.lunaris/capabilities/skills/scratch" }   # path deps never enter the registry

[capabilities.mcp.postgres]
package   = "@org/postgres-mcp@^1"
transport = "stdio"
isolation = "container"                           # process | container
env       = { DATABASE_URL = "secret://billing-db-url" }
network   = { allow = ["db.internal:5432"] }
tools     = { allow = ["query", "schema"], deny = ["execute_ddl"] }
enabled   = true

[capabilities.tools]
fs    = { scope = ["."], extra_paths = ["~/shared-datasets:ro"] }
shell = { enabled = true }                        # autonomy: no per-command prompts; scope-enforced

[providers.anthropic]
type    = "anthropic"
api_key = "secret://global/anthropic"
[providers.deepseek]
type    = "deepseek"
api_key = "secret://global/deepseek"
[providers.local]
type     = "ollama"
base_url = "http://127.0.0.1:11434"

[memory]
engine          = "graphify"
embedding_model = "local/nomic-embed-text"
clustering      = { algorithm = "leiden", resolution = 1.0 }
curation        = { decay_half_life_days = 30, max_nodes = 50000, prune = "on_threshold" }
gate            = { commit = 0.55, quarantine = 0.40, weights = [0.25, 0.30, 0.15, 0.15, 0.15] }
global_tier     = true
trust           = "advisory"                      # guide-not-oracle: injected with verify-before-trust framing

[devenv]
provisioner = "devcontainer"                      # devcontainer | nix | dockerfile | probe (auto-detect fallback)
verify      = "make test-smoke"                   # health command run by `lun devenv verify`

[taxonomy]
namespace = "x.billing"

# [workspace]                                     # monorepo only
# members = ["packages/*", "services/api"]
# orchestration = "single"                        # single | federated

[lifecycle.backup]
schedule  = { incremental = "hourly", full = "daily" }
targets   = ["local"]                             # local | s3://bucket/prefix | git-ref
retention = { hourly = 24, daily = 30, weekly = 12, monthly = 12 }

[team.memory]
promotion = "owner-review"                        # auto | any-member | owner-review
```

NOTE: routing rules, budgets, and autonomy policy are schema-rejected here (§2.3).

### A.2 `.lunaris/config/routing.yaml` (optimizer lane)

```yaml
schema_version: 1
defaults:
  provider_alias: anthropic
  model: <frontier-model>
  max_retries: 2
  fallback_chain: [deepseek/deepseek-chat, local/<local-14b>]
scorer:                       # optimizer-tunable utility weights
  weights: { quality: 0.55, cost: 0.20, latency: 0.15, reliability: 0.10 }
rules:
  - priority: 100
    match: { task_class: "code.review", agent_role: reviewer }
    route: { provider_alias: deepseek, model: deepseek-chat,        # reviewer must differ from author model
             fallback_chain: [anthropic/<frontier-model>] }
  - priority: 90
    match: { task_class: "code.*", complexity_tier: 4 }
    route: { provider_alias: anthropic, model: <frontier-model>, params: { max_output_tokens: 16000 } }
  - priority: 50
    match: { task_class: ["memory.curate", "orchestrate.review"], latency_class: batch }
    route: { provider_alias: local, model: <local-14b>, fallback_chain: [deepseek/deepseek-chat] }
  - priority: 40
    match: { task_class: "research.web" }
    route: { provider_alias: anthropic, model: <long-context-model> }
shadow:  { enabled: true, percent: 5, budget_usd_per_day: 1.50, candidates: [deepseek/deepseek-chat] }
canary:  { enabled: false, percent: 10, rollback_if_success_drop_pp: 5, window_calls: 50 }
semantic_cache_task_classes: [docs.write, research.codebase]
```

Invariants enforced by ConfigD at commit: every `provider_alias` ∈ `lunaris.toml [providers]`; every `task_class` glob compiles against the taxonomy; no budget or secret keys.

### A.3 `.lunaris/config/budgets.yaml` (human lane)

```yaml
schema_version: 1
limits:
  usd_per_task: 5.00
  usd_per_run:  15.00
  usd_per_day:  40.00
  tokens_per_task: 2000000
soft_warn_pct: 80
on_exceed: degrade-to-cheaper        # pause | degrade-to-cheaper | abort
degrade_to: [local/<local-coder>, deepseek/deepseek-chat]
exemptions: []                       # e.g. goal ids granted a one-off raise via the UI
```

Machine-level `~/.lunaris/config/budgets.yaml` merges by MIN — a project can tighten but never loosen the machine cap.

### A.4 `.lunaris/config/policy.yaml` (human lane)

```yaml
schema_version: 1
autonomy_level: autonomous_sandbox   # read_only | supervised | autonomous_sandbox | full_auto
rules:
  - deny:  { tool: Bash, command: ["git push --force*", "* --no-verify *", "curl * | sh"] }
  - queue: { class: ["irreversible.*"], ttl: 24h }
  - allow: { tool: Bash, command: ["npm *", "pnpm *", "pytest*", "git *", "make *"] }
  - allow: { net: ["registry.npmjs.org", "pypi.org", "*.github.com"] }
  - deny:  { path_write: ["/**"], except_workspace: true }      # writes jailed to the worktree
sandbox:
  runtime: docker                    # docker | podman | jail (bubblewrap/seatbelt)
  image: "lunaris/base:node20-py312"
  mem: 4g
  pids: 512
git:
  protected_branches: [main, "release/*"]
  checkpoint_interval: 10m
  pr_gate: required                  # required | auto_merge_on_green | off
approvals:
  auto_approve: []                   # e.g. ["deploy.staging"] at full_auto
  notify: [push, ui]
secrets:
  subagent_grants: {}                # role -> [secret names]; default none
upgrade:
  default_mode: drain                # drain | checkpoint | defer (per run-priority class)
  drain_deadline: 10m
  settle_window: 72h
```

No budget keys — the schema rejects them (budgets live only in A.3).

### A.5 Automation files

`.lunaris/automation/schedules.yaml`:

```yaml
schedules:
  - name: nightly-dependency-bump
    cron: "0 3 * * *"
    timezone: Australia/Sydney
    jitter_s: 300
    template: dependency-bump
    params: { scope: "minor" }
    concurrency_policy: skip         # skip | queue | replace
    catch_up_policy: run_once        # skip_missed | run_once | run_all
    budget: { max_usd: 2.00 }
    enabled: true
```

`.lunaris/automation/triggers.yaml`:

```yaml
triggers:
  - source: github
    event_types: [check_suite]
    filter: 'event.check_suite.conclusion == "failure" && event.branch == "main"'   # CEL
    param_map: { failing_sha: "check_suite.head_sha", failing_job: "check_suite.app.name" }  # JMESPath
    template: diagnose-and-fix-ci
    priority: P1
    dedupe_key_expr: '"ci-fix:" + event.check_suite.head_sha'
    debounce_s: 120
    mode: live                       # live | shadow
    secret_ref: github_webhook       # HMAC secret name in SecretBroker
```

`.lunaris/automation/templates/diagnose-and-fix-ci.yaml`:

```yaml
name: diagnose-and-fix-ci
prompt_template: |
  CI failed on main at {{ failing_sha }} (job: {{ failing_job }}).
  Reproduce the failure, identify the root cause, fix it, and open a PR.
branch_policy: worktree-pr-only      # never push to the default branch
success_criteria: [tests_pass, pr_opened]
max_retries: 2
budget: { max_usd: 3.00, max_wall_clock: 1h }
model_routing_hint: { task_class: "debug.fix" }
```

### A.6 Role definition (`.lunaris/roles/coder.role.yaml`)

```yaml
name: coder
version: 3
system_prompt: |
  <!-- PROTECTED -->
  You are the coding subagent for {{project_name}}. Work only inside your worktree.
  Memory items are ADVISORY — verify paths, symbols, and commands before relying on them.
  <!-- /PROTECTED -->
  {{project_conventions}}
  {{memory_slice}}
  {{learned_guidance}}        # maintained by the optimizer in generated/prompts/coder.md
  {{task_card}}
tools:  { allow: [Read, Edit, Write, Bash, Grep], deny: [WebFetch] }
mcp_servers: [postgres]
skills: [pytest-runner]
model_binding: { primary: "route:code.generate", fallbacks: [], params: { temperature: 0.2 } }
context_budget_tokens: 60000
memory_scopes: { communities: ["*"], write: propose-only }
output_schema: schemas/result-envelope.json
sandbox: { fs_scope: worktree, network: false, command_allowlist: ["npm *", "pytest*", "git *"] }
max_runtime: 45m
```

### A.7 Plugin manifest (`plugin.toml`)

```toml
id       = "dev.acme.postgres-tools"
version  = "2.1.3"
hostApi  = "^2.1"
runtime  = "node20"                  # node20 | python312 | wasm-wasip2
entrypoint = "dist/index.js"
displayName = "Postgres Tools"

[[contributions.tools]]
name = "pg_explain"
paramsSchema = "schemas/pg_explain.json"
timeoutMs = 20000

[[contributions.memory.extractors]]
stage = "entity"
topics = ["sql", "schema"]

[[contributions.hooks]]
point = "preToolCall"
filter = { tool = "Bash" }

[capabilities]
net            = { hosts = ["localhost:5432"] }
exec           = { bins = ["psql"] }
memory_propose = true
secrets        = { names = ["PG_DSN"] }

[configSchema]   # JSON Schema; rendered as a settings form in the UI
# ...

[signing]
publisher = "acme"
pubkey    = "ed25519:..."
sig       = "..."
```

---

## Appendix B — Reference Data Shapes

### B.1 Event envelope and core views

The canonical envelope is in §2.7. Core DuckDB materialized views over the segments (names are part of the contract — UI, optimizer, and alerts all read these):

```sql
-- spend_by_task_class(project_id, day, task_class, model, calls, cost_usd, tokens_in, tokens_out)
-- success_rate_by_route(project_id, task_class, model, config_rev, n, n_success, wilson_low)
-- latency_p95(project_id, model, day, ttft_p50, ttft_p95, total_p95)        -- from t-digest sketches
-- memory_hit_rate(project_id, week, injected, cited, confirmed, contradicted)
-- budget_ledger(project_id, scope, window, spent_usd)                       -- reporting only; enforcement = gateway's transactional ledger (§2.7)
-- model_scorecard(model, task_class, n, success_rate, usd_per_success, p50_latency_ms, retry_rate)
-- agent_scorecard(agent_role, n, success_rate, cost_share, wasted_work_usd)
-- tool_scorecard(tool, source, calls, error_rate, p50_ms, avg_result_bytes)
-- task_summary(task_id, ...)        -- one row per task; see §8
```

### B.2 Orchestrator shapes

```ts
type Task = {
  task_id: string; goal_id: string; title: string; role: string;
  instructions: string; inputs: Ref[]; expected_artifacts: string[];
  acceptance_checks: string[];                       // commands / test names / reviewer rubric
  deps: string[];                                    // hard or soft
  pattern: 'solo'|'fanout'|'pipeline'|'gate'|'adversarial'|'race'|'mapreduce';
  est: { tokens: number; usd: number; minutes: number };
  max_attempts: number; model_hint?: string;
  state: 'PENDING'|'READY'|'LEASED'|'RUNNING'|'NEEDS_REVIEW'|'DONE'|'FAILED'|'BLOCKED'|'CANCELLED';
};

type ResultEnvelope = {
  task_id: string;
  status: 'success'|'partial'|'failed'|'blocked'|'needs_decomposition';
  summary: string;                                   // <=500 tokens: what was done, how verified
  artifacts: Ref[];
  metrics: { tokens_in: number; tokens_out: number; usd: number; wallclock_s: number; tool_calls: number };
  confidence: number;                                // 0..1
  open_questions: string[]; risks: string[];
  memory_proposals: { statement: string; entities: string[]; relation: string;
                      evidence_artifact?: Ref; confidence: number }[];
  subplan?: Task[];                                  // when needs_decomposition
};

type Message = {
  msg_id: string; from: string; to: string | 'orchestrator' | `broadcast:${string}`;
  type: 'question'|'status'|'artifact_ready'|'blocker'|'finding'|'handoff';
  body: string;                                      // <=2k tokens; longer content must be an artifact ref
  refs: Ref[];
};

type GateVerdict = {
  task_id: string; reviewer_agent: string;
  verdict: 'approve'|'request_changes'|'escalate';
  findings: { severity: string; file: string; line?: number; claim: string; suggested_fix?: string }[];
  confidence: number;
};

type Checkpoint = {
  ckpt_id: string; journal_offset: number; board_snapshot_ref: string;
  worktree_commits: Record<string /*task_id*/, string /*sha*/>;
  live_sessions: { agent_id: string; session_id: string; transcript_offset: number }[];
  router_state: unknown;
};
```

### B.3 ModelGateway shapes (abridged)

```ts
interface UnifiedRequest {
  messages: UMessage[];                              // multi-part: text|image|tool_use|tool_result|thinking
  tools?: { name: string; description: string; inputSchema: JSONSchema }[];
  toolChoice?: 'auto'|'none'|'required'|{ name: string };
  responseFormat?: { type: 'text' } | { type: 'json_schema'; schema: JSONSchema; strict?: boolean };
  maxTokens?: number; temperature?: number; stopSequences?: string[];
  routing: { role?: string; task_class?: string; model?: string;
             tier?: 'frontier'|'workhorse'|'cheap'|'local';
             qualityFloor?: 1|2|3|4|5; privacy?: 'any'|'local-only';
             maxCostUSD?: number; latency?: 'interactive'|'batch' };
  metadata: { project_id: string; task_id: string; agent_id: string; agent_role: string; trace_id: string };
  cache?: { mode: 'exact'|'semantic'|'off'; ttlSec?: number };
}

type UnifiedEvent = { epoch: number } & (
  | { type: 'message_start'; model: string; provider: string; fallbackDepth: number }
  | { type: 'text_delta'; text: string } | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsJsonFragment: string }
  | { type: 'tool_call_end'; index: number; args: unknown }
  | { type: 'usage'; tokensIn: number; tokensOut: number; cachedIn: number }
  | { type: 'message_end'; stopReason: 'end_turn'|'tool_use'|'max_tokens'|'stop_sequence'|'content_filter'|'error' }
  | { type: 'error'; errorClass: ErrorClass; message: string; retriable: boolean });

interface ModelEntry {
  id: string; provider: string; family: string;
  contextWindow: number; maxOutputTokens: number;
  modalities: ('text'|'image'|'audio')[];
  toolCallQuality: 1|2|3|4|5; supportsParallelTools: boolean; supportsThinking: boolean;
  structuredOutputMode: 'native-strict'|'tool-trick'|'grammar'|'prompt-only';
  costPerMtokIn: number; costPerMtokOut: number; costPerMtokCachedIn?: number;
  latencyClass: 'fast'|'standard'|'slow';
  measured?: { p50TtftMs: number; p50TokPerSec: number; updatedAt: string };
  localOnly: boolean; tier: 'frontier'|'workhorse'|'cheap'|'local';
  knockouts: string[]; sunset?: string;
}

interface RouteDecision {
  chosen: ModelEntry;
  candidates: { model: string; score: number; filteredBy?: string }[];
  ruleId?: string; explanation: string; estimatedCostUSD: number;
}
```

### B.4 Memory store schema (sketch) and brief format

```sql
entities(id TEXT PK /*ulid*/, canonical_name, kind CHECK(kind IN
  ('code_symbol','file','concept','service','person','dataset','decision','task_type','error_mode','convention')),
  description, aliases JSON, community_id, degree INT, embedding BLOB,
  first_seen, last_confirmed, source_refs JSON, layer CHECK(layer IN('team','personal')), author);

relations(id PK, src FK, dst FK, relation TEXT,
  confidence_tag CHECK(IN('EXTRACTED','INFERRED','AMBIGUOUS')), confidence_score REAL,
  weight REAL, evidence JSON, valid_from, invalidated_at NULL, hlc);
  -- vocab: calls, implements, depends_on, documented_in, decided_because, caused_failure,
  --        fixed_by, similar_to, supersedes, contradicts, contrasts_with, scoped_exception

memories(id PK, type CHECK(IN('episodic','semantic','procedural')), tier CHECK(IN('project','global')),
  title, body TEXT /*<=200 tok*/, condition_text NULL, entity_ids JSON,
  confidence REAL, strength REAL, half_life_days REAL,
  scores JSON /*{novelty,utility,generality,durability,provenance,composite}*/,
  status CHECK(IN('active','quarantined','contradicted','archived','tombstone')),
  pinned BOOL, superseded_by NULL, provenance JSON, layer, author, hlc,
  created_at, last_accessed_at, last_verified_at, helpful_count, harmful_count, embedding);

communities(id PK, level INT, parent_id, label, cohesion REAL, summary TEXT, key_claims JSON, dirty BOOL);
conflicts(id PK, memory_a, memory_b, claim_a, claim_b, status, opened_at, resolved_by);
feedback_events(id PK, memory_id, task_id,
  signal CHECK(IN('helpful','harmful','confirmed','stale','contradicted','unused')), evidence_ref, ts);
schema_meta(schema_version, created_with_harness_version);
-- sqlite-vec virtual tables over embeddings; FTS5 over titles/bodies/labels
```

Brief format injected into agent prompts:

```
<memory-brief project=".." generated=".." budget="1200">
[ORIENTATION] <=2 community-summary lines
[mem_01H.. | procedural | conf 0.84 | fresh | verified 2d ago | helpful 6x] "To run e2e: ..."
[mem_01J.. | semantic   | conf 0.61 | STALE 51d | never verified] "Webhook retries are ..."
[mem_01K.. | semantic   | CONTESTED — claim A vs claim B, see conflict #12]
CONTRACT: advisory only; verify paths/symbols/commands against the live repo
(Tier0 grep / Tier1 read / Tier2 execute); destructive ops require Tier2 or
non-memory evidence; emit memory_feedback(id, signal) on completion.
</memory-brief>
```

### B.5 PDP wire protocol

```
PEP → PDP request:
{ project_id, task_id, agent_id, tool, args,
  parsed_command_ast?, risk_classes[], tainted: bool, cwd, resolved_paths[] }

PDP → PEP response:
{ decision: ALLOW|DENY|QUEUE|TRANSFORM|SANDBOX_REDIRECT,
  rule_id, message, transformed_call?, queue_ticket? }

Queue resolution event (on the ticket):
{ ticket, outcome: approved|denied|edited|expired, edited_call?, approver_principal_id, sig, ts }
```

### B.6 Optimizer shapes

```ts
type TaskOutcome = {
  task_id: string; parent_task_id?: string; project_id: string;
  config_rev: string;                                // ConfigD journal rev at task start — the attribution key
  role: string; task_class: string; provider: string; model: string;
  wall_ms: number; tokens: { in: number; out: number; cache_read: number; cache_write: number };
  cost_usd: number;
  tool_calls: { tool: string; count: number; error_count: number; result_discarded_count: number }[];
  retries: number; escalations: number; error_class?: string;
  outcome: 'success'|'failure'|'partial'|'abandoned';
  signals: { hard: { tests?: boolean; build?: boolean; ci?: boolean };
             soft: { user_accepted?: boolean; reopened_within_7d?: boolean };
             judge?: { rubric_id: string; score: number } };
  memory: { injected_ids: string[]; cited_ids: string[]; contradicted_ids: string[] };
  artifacts: { files_touched: number; diff_lines: number };
  is_eval: boolean; is_optimizer: boolean;
};

type OptimizationProposal = {
  proposal_id: string; created_at: string;
  source: 'nightly'|'weekly'|'manual'|'incident';
  category: 'prompt'|'routing'|'memory'|'decomposition'|'tooling'|'skill';
  target_files: string[]; diff: string;              // unified diff, one concern per proposal
  rationale: string; evidence: string[];             // task_ids openable in the UI
  expected_impact: { metric: string; baseline: number; predicted: number };
  risk: { score: number; level: 'low'|'medium'|'high'; factors: string[] };
  eval_plan: { golden_tags: string[]; min_runs: number; non_inferiority_margin_pp: number; target_metric: string };
  status: 'draft'|'replay_filter'|'evaluating'|'pending_approval'|'adopted'|'rejected'|'rolled_back'|'expired';
  eval_results?: { baseline: unknown; candidate: unknown; per_golden: unknown[] };
  decided_by?: 'auto'|'user'; adopted_rev?: string;
  monitoring?: { window_tasks: number; baseline_success: number; outcome?: string };
};

type GoldenTask = {
  golden_id: string; origin_task_id: string; prompt: string;
  snapshot: string;                                  // git bundle ref of pre-task repo state
  checks: { type: 'pytest'|'shell'|'file_match'|'judge_rubric'; spec: unknown }[];
  budget: { max_cost_usd: number; max_wall_ms: number };
  tags: string[]; reps: number; last_calibrated: string; flaky_variance?: number;
};
```

### B.7 Identity, lease, and audit shapes

```ts
type Principal = {
  principal_id: string;            // usr_* | node_* | agt_* | svc_* + ulid
  kind: 'user'|'node'|'agent_run'|'service';
  display_name: string; status: 'active'|'suspended';
  parent_principal_id?: string;    // agt_* parented to the usr_/svc_ that started the run
};

type Lease = {
  project_id: string; holder: string /*agt_**/; node_id: string;
  epoch: number;                   // monotonic u64; FENCING: stale-epoch writes rejected (409 LEASE_FENCED)
  acquired_at: string; heartbeat_at: string; ttl_s: 45;
};

type AgentToken = {                // biscuit-style; subagents receive attenuations only (caps can only shrink)
  project_id: string; run_id: string; lease_epoch: number;
  caps: string[];                  // e.g. 'fs.write:/repo', 'exec:test-runner', 'net:allowlist', 'provider:local', 'spawn'
};

type AuditRecord = {
  action_id: string; principal_id: string; session_id?: string;
  action_type: string; target: string; payload_hash: string;
  prev_record_hash: string; ts: string; sig: string;
  attestation_level: 'device'|'server';
};
```

### B.8 Bundle layout and sync journal op

```
project.aihbundle  (zstd(tar), deterministic entry order, optional age encryption)
├── META/manifest.json          { format_version, project_id, created_at, harness_version,
│                                 subsystem_schema_versions{}, scope, audience, parents[] }
├── META/integrity.json         { blake3_merkle_root, per_entry_hashes }
├── META/secrets.manifest.json  [ { name, purpose } ]      # names only, NEVER values
├── STATE/memory/*.jsonl        # entities/relations w/ provenance+HLC; communities EXCLUDED (derived)
├── STATE/analytics/*.parquet
├── STATE/optimizer/{policy.json, prompts/, routing-priors.json}
├── STATE/golden/*.task.json
├── STATE/board/*.jsonl
├── ENV/{lunaris.toml, lunaris.lock}
└── CAS/<blake3>                # referenced content-addressed blobs
```

```jsonc
// sync journal op (statepacks = packed segment ranges; transports: git-ref | s3 | sync server)
{ "op_id": "01J9...", "actor_id": "usr_...", "instance_id": "...",
  "hlc": "...", "subsystem": "memory", "op_type": "assert_relation", "payload": { } }
```

### B.9 Goal queue tables (automation.db)

```sql
schedules(id, name, kind /*user|system*/, spec_json /*cron|interval|at, tz, jitter*/,
  template_id, params_json, enabled, concurrency_policy, catch_up_policy,
  budget_json, next_run_at, consecutive_failures, created_by);

trigger_rules(id, source, event_types_json, filter_cel, param_map_json, template_id,
  priority, dedupe_key_expr, debounce_s, mode /*live|shadow*/, enabled);

intake_events(id, source, event_type, delivery_id UNIQUE, payload_blob_ref, sig_ok,
  received_at, verdict /*matched|ignored|deduped|rate_limited|invalid_signature*/,
  matched_rule_id, goal_id, correlation_id);

goal_queue(id, source_json /*{type: ui|cli|schedule|trigger|api, ref_id}*/, template_id,
  prompt_rendered, params_json, priority, state, dedupe_key, not_before,
  lease_worker, lease_expires_at, attempts, max_retries, budget_json,
  correlation_id, run_id, result_json, created_at, updated_at);

approvals(id, goal_id, requested_action, plan_preview, requested_at,
  decided_at, decision, decided_by /*principal_id*/);

poller_cursors(poller_id, cursor_json);
```





