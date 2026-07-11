# Implementation Plan: Callback Channel & Reports

**Branch**: `004-callback-channel-reports` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-callback-channel-reports/spec.md`

## Summary

Give the running agent a **live in-session voice** — three MCP tools (`report_progress`,
`request_human`, `complete_task`) that reach an authenticated HTTP callback API — and retire the
iteration-3 stdout report channel for any run wired to those tools. The agent reports as it works,
escalates blockers mid-run, and finalizes with a schema-valid report; the orchestrator turns those
reports into Jira transitions, comments, checklists, and human-queue tasks. Exactly one live
completion channel exists per run; a process that ends without a sanctioned callback fails closed
(FR-010/011).

Technical approach, verified against the operator's installed CLI (**v2.1.207**, prototyped
2026-07-11 — see `research.md` D1/D2):

- **Token handoff (security core):** the per-run JWT is written as a **literal value** inside a
  per-run `0600` mcp-config file's server `env` block. Prototype proved the Bash tool inherits
  `claude`'s own process env (so `${VAR}` interpolation would leak the token to the agent), whereas
  a literal `env` value in the mcp-config reaches **only** the spawned `brigadir-mcp` child and is
  `UNSET` in the agent's Bash. Token never in argv, never in the agent's visible env.
- **MCP server:** a new thin `packages/mcp-server` (`brigadir-mcp`, stdio) with **zero DB access** —
  each tool handler `POST`s to the backend `CallbackModule` HTTP API with the run token from its own
  env, and writes the on-disk **completion marker** on a successful `complete_task` / blocking
  `request_human`.
- **Session enforcement:** a `Stop` hook injected via `--settings` (fires in print mode, prototype
  D2) blocks session end while the marker is absent; `stop_hook_active` bounds it to one block
  (FR-023). Best-effort UX — FR-010 fail-closed is the real guarantee.
- **Executor changes:** `claude_cli` mints the JWT, writes the mcp-config, registers the Stop hook,
  **drops `--json-schema`** for callback-wired runs, keeps everything else from iteration 3
  (worktree, env allowlist, group-kill, stream parsing → run_events). Channel selection is
  **explicit config** (`useCallbackChannel`), not implicit magic.
- **Backend:** new `CallbackModule` (guarded HTTP API), `HumanTaskModule` (create / resolve / resume
  transaction), a **secret scrubber**, and **feature-context** compilation for the wrapper. The
  completion contract reuses the existing `RunsService.finalizeWithReport` + `PipelineService`.

The completion-contract flows (FR-007–020) are canonical from architecture §5 — encoded here, not
redesigned. The report schema (`ReportSchema`) and callback-tool schemas already exist in
`packages/contracts`.

## Technical Context

**Language/Version**: TypeScript strict (5.x), Node 20 (`.nvmrc`)

**Primary Dependencies**: NestJS 11 (backend + worker WorkerHost), BullMQ 5, Drizzle ORM +
Postgres 16, zod 3.24, `@nestjs/platform-express`. **New:** `@modelcontextprotocol/sdk` (stdio MCP
server in `packages/mcp-server` only — see Complexity Tracking). JWT via **node built-in `crypto`
HS256** — no new dependency (research D4).

**Storage**: Postgres 16 (system of record); Redis/BullMQ queues only. **No migration** — all
columns already exist (data-model.md; architecture §3).

**Testing**: vitest unit + `test:integration` (vitest + testcontainers, real Postgres/Redis, no
mocked broker). Callback flows exercised end-to-end via the substitutable **fake CLI**
(`test/fixtures/claude-cli/fake-claude.mjs`) which calls the **real** callback HTTP API with the run
token from its server-side env (SC-009, quickstart.md).

**Target Platform**: Linux/macOS self-hosted single host (Phase 0–1 of architecture §8): backend +
worker + agent processes co-resident; agents reach `CallbackModule` over localhost HTTP.

**Project Type**: NestJS monorepo — `apps/{backend,worker}`, `libs/*` (feature libs), `packages/*`
(`contracts`, new `mcp-server`).

**Performance Goals**: not latency-bound; callback API handles low-volume per-run traffic. Bounded
retries on transient callback failures (FR-006).

**Constraints**: secrets never in argv/agent env (Constitution V); lazy resource resolution — JWT
secret + callback base URL resolved in DI factories, never at `@Module()` composition
(Constitution "Lazy resource resolution"); every outgoing agent text scrubbed before persist/Jira.

**Scale/Scope**: internal tool, single workspace. Scope: 1 new backend module (`CallbackModule`),
1 new human-task module, 1 new `packages/mcp-server`, 1 scrubber util, feature-context compiler,
`claude_cli` executor changes; mock executor and feature-003 lifecycle tests untouched.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.0.*

| Principle | Status | Notes |
|---|---|---|
| I. Dual Source of Truth | ✅ PASS | Jira status only via `JiraClient` transitions; run/human-task state in Postgres. Callbacks mutate PG; Jira writes flow through `PipelineService`/per-issue write queue. `awaiting_human` and `superseded` are PG run states already in the enum. |
| II. Idempotency (3 levels) | ✅ PASS | `complete_task` idempotent via guarded terminal UPDATE (409 on repeat, FR-009). The **resume** path creates the new attempt through the same `runs_one_active` DB guard (level 3) inside one transaction, and enqueues with BullMQ dedup (level 2). Webhook dedup (level 1) unaffected. |
| III. System-Only Jira Writes | ✅ PASS | Agents speak only through the three callback tools; **all** Jira transitions/comments/human-tasks are performed by the system from those callbacks. `--strict-mcp-config` + explicit `--settings` prevent host config leaking a rogue Jira MCP into the run. |
| IV. Run Completion Contract | ✅ PASS | `complete_task` validated against `ReportSchema` (`needs_human` ⇒ `human_task`); fail-closed on silent exit (FR-010); stdout channel retired for callback-wired runs (FR-011); repeat completion → 409. |
| V. Secret Isolation & Scrubbing | ⚠️ PARTIAL — justified | Token never in argv; never in the agent's visible env (prototype-verified). Scrubber on all outgoing text. **Conflict:** V's example prescribes `${VAR}` interpolation "never inline values"; the prototype (D1) proves `${VAR}` leaks the token into the agent's Bash env on v2.1.207, so we use a **literal** value in a `0600` mcp-config file instead — serving V's *spirit* (secret unreachable to the agent) while deviating from its *letter*. See Complexity Tracking + recommended constitution PATCH. |
| VI. Test-Mandatory Pipeline Logic | ✅ PASS | Callback validation, completion, resume, human-task, scrubber, fail-closed — all covered by integration tests against real PG/Redis + fake CLI hitting the real callback API. |

**Gate result:** PASS with one justified, documented deviation (Constitution V letter). No unjustified
violations. Re-check after Phase 1: unchanged — the literal-file decision is the Phase-0 research
output and is the reason for the deviation; design does not introduce further conflicts.

## Project Structure

### Documentation (this feature)

```text
specs/004-callback-channel-reports/
├── plan.md              # This file
├── research.md          # Phase 0 — D1..D9 verified mechanics
├── data-model.md        # Phase 1 — entities (no migration)
├── quickstart.md        # Phase 1 — fake-CLI-with-callbacks test pattern
├── contracts/           # Phase 1
│   ├── callback-http-api.md
│   ├── mcp-config.md
│   ├── stop-hook-settings.md
│   └── run-jwt.md
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/
├── contracts/src/
│   ├── report.schema.ts           # (exists) ReportSchema — reused verbatim
│   ├── callback-tools.schema.ts   # (exists) tool arg schemas — reused
│   └── run-token.ts               # NEW — HS256 sign/verify (node crypto), RunTokenClaims type
└── mcp-server/                    # NEW package — bin `brigadir-mcp` (stdio, zero DB)
    ├── package.json               # depends on @modelcontextprotocol/sdk + @brigadir/contracts
    └── src/
        ├── main.ts                # stdio server bootstrap; env: RUN_ID, CALLBACK_URL, RUN_TOKEN, MARKER_PATH
        ├── tools.ts               # report_progress / request_human / complete_task → HTTP POST + repair errors
        └── marker.ts              # write completion marker on complete / blocking request_human

libs/
├── callback/                      # NEW — CallbackModule (mounted in apps/backend)
│   └── src/
│       ├── callback.controller.ts # POST /api/callbacks/runs/:runId/{progress,human,complete}
│       ├── run-token.guard.ts     # verify JWT + sub==:runId + run status ∈ {running,awaiting_human} (FR-003)
│       ├── callback.service.ts    # progress→run_events+SSE; complete→RunsService+Pipeline; PR review task
│       └── callback.module.ts
├── human-tasks/                   # NEW — HumanTaskModule
│   └── src/
│       ├── human-task.service.ts  # create (blocking parks run + Blocked + comment; non-blocking just queues)
│       ├── resume.service.ts      # resolve(resume|done_manually|dismiss); resume = one-tx supersede+new attempt
│       └── human-tasks.module.ts
├── scrubber/                      # NEW — secret scrubber (regex + entropy), server-side
│   └── src/scrubber.ts
├── executors/src/claude-cli/
│   ├── args.ts                    # CHANGE — drop --json-schema when useCallbackChannel; keep rest
│   ├── mcp-config.ts              # NEW — write 0600 mcp.json (literal token env block) + Stop-hook settings
│   ├── wrapper.ts                 # NEW/EXTRACT — MCP-tools section + feature-context section (FR-026)
│   └── claude-cli.executor.ts     # CHANGE — mint JWT, write mcp-config, register Stop hook, marker path
├── jira/src/jira-client.interface.ts  # CHANGE — add bounded feature-context read (epic + linked statuses)
└── runs/src/runs.service.ts       # CHANGE — add failIfStillRunning() (guard WHERE status='running' only)

apps/
├── backend/src/app.module.ts      # CHANGE — import CallbackModule, HumanTaskModule
└── worker/src/claude-cli-run.processor.ts  # CHANGE — real JWT + callback base URL into RunContext; fail-closed
```

**Structure Decision**: Existing NestJS-monorepo layout (`apps/*` + `libs/*` + `packages/*`).
`CallbackModule` and `HumanTaskModule` are new **feature libs** consumed by `apps/backend`
(agents reach them over localhost HTTP, matching architecture §1's module table). `brigadir-mcp` is
a new **package** (not a lib) because it is a standalone stdio binary the CLI spawns, with zero
dependency on the Nest DI graph or the DB — it only imports `@brigadir/contracts` for the tool arg
schemas and token claims type.

## Phases

- **Phase 0 — Research (`research.md`, DONE):** verified the two hard unknowns on the installed CLI
  (D1 token isolation, D2 Stop hook in print mode) plus D3 tool naming/allowlist, D4 JWT via node
  crypto, D5 wrapper feature-context sourcing & budget, and D6–D9 supporting mechanics. All
  NEEDS CLARIFICATION resolved.
- **Phase 1 — Design & Contracts (`data-model.md`, `contracts/`, `quickstart.md`, DONE):** entities
  confirmed against architecture §3 → **no migration**; callback HTTP API, mcp-config shape, Stop-hook
  settings JSON, and run-JWT contracts written; quickstart documents the fake-CLI-with-callbacks
  integration pattern.
- **Phase 2 — Tasks (`/speckit-tasks`, NOT in this command):** derive dependency-ordered tasks:
  contracts (`run-token`) → `packages/mcp-server` → `libs/scrubber` → `libs/callback` +
  `libs/human-tasks` → executor changes (`mcp-config`, `wrapper`, `args`, executor, processor) →
  feature-context read → integration suites. Tests ship in the same tasks as the logic (Principle VI).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Constitution V letter** — literal run token in a `0600` mcp-config file instead of `${VAR}` interpolation | Prototype on v2.1.207 (research D1) proved the Bash tool inherits `claude`'s process env, so `${BRIGADIR_RUN_TOKEN}` interpolation exposes the token to the agent (`printenv` sees it) — a direct FR-004/FR-005 violation. A literal `env` value in the mcp-config reaches only the `brigadir-mcp` child (verified `IS_UNSET` in the agent's Bash). | `${VAR}` interpolation (the constitution's own example) is the *simpler* path but is **insecure on this CLI version** — it is the exact leak FR-004/005 forbid. The literal file keeps the token out of argv and out of the agent's env; residual on-disk exposure is mitigated (0600, outside the worktree, deleted at cleanup) and bounded (token is single-run, short-TTL, callback-only, DB-state re-checked every call — FR-003). **Recommend a constitution PATCH** replacing the `${VAR}` example with the literal-file mechanism, citing this prototype. |
| **New dependency** `@modelcontextprotocol/sdk` (in `packages/mcp-server` only) | Correct MCP stdio JSON-RPC framing/handshake is easy to get subtly wrong; the official SDK is the canonical, maintained implementation. | Hand-rolling the stdio JSON-RPC protocol is more code and a correctness risk for the load-bearing agent voice. The dep is isolated to one thin package with zero DB access and no Nest coupling; the run-token JWT still uses node `crypto` (no dep) per the "prefer no new runtime deps" constraint. |
