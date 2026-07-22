# Tasks: First-class deepseek_api executor type (DeepSeek backend)

**Input**: Design documents from `/specs/028-deepseek-executor/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — all present.

**Tests**: MANDATORY for everything except the pure-UI tasks (constitution Principle VI — executor lifecycle, enqueue, callbacks are pipeline logic; spec FR-019). Test tasks live in the same phase as the functionality they cover.

**Organization**: Grouped by user story from spec.md. US1 (deepseek runs e2e), US2 (existing types untouched), and US3 (live smoke) are all P1. US3 runs LAST despite its priority — the spec explicitly gates it on green quality gates; it is the definition-of-done, not an early increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US6 per spec.md

## Path Conventions

Monorepo per plan.md: `packages/contracts/`, `libs/executors/`, `libs/queues/` (spec-only change), `apps/worker/`, `apps/backend/`, `apps/web/`, `test/integration/`, `docs/`. Line numbers verified 2026-07-22 (see plan.md).

---

## Phase 1: Setup

**Purpose**: Baseline verification — no scaffolding needed (no new packages, no DDL).

- [X] T001 Verify green baseline before any edits: run `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration` (Docker required); record any pre-existing failures so they are not attributed to this feature (repository root)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contracts (typed branches + FR-016 shared constants), endpoint constant, generalized guard, DI registration — every user story depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] In `packages/contracts/src/executor.schema.ts`: add `'deepseek_api'` to `ExecutorTypeSchema` (line 48); add `DeepseekExecutorApiConfigSchema` — literal clone of `KimiExecutorApiConfigSchema` (lines 147–161) with `type: z.literal('deepseek_api')` (`.strict()`; model, cli_path, use_callback_channel, keep_failed_worktrees, max_turns, max_parallel_runs, write-only nullable-optional api_key); include it in all three unions — `ExecutorApiConfigSchema` (167–171), `ExecutorCreateRequestSchema` with the create-only "deepseek_api requires an api_key on create" refinement mirroring the kimi one (184–209), `ExecutorUpdateRequestSchema` (216–221); export NEW shared constants `API_KEY_ONLY_EXECUTOR_TYPES = ['kimi','deepseek_api']` and `CLI_HARNESS_API_EXECUTOR_TYPES = ['claude_cli','kimi','deepseek_api']` with type guards (research D4, per `contracts/deepseek-executor-api.md`)
- [X] T003 [P] In `packages/contracts/src/agents-config.schema.ts`: add `'deepseek_api'` to `RUN_QUEUE_EXECUTOR_TYPES` (line 33 — this alone provisions the `run.deepseek_api` BullMQ queue; no queue-module edits); add `DeepseekExecutorConfigSchema` — clone of `KimiExecutorConfigSchema` (129–147) with the deepseek literal — and REPLACE `passthroughExecutorConfig('deepseek_api')` in `ExecutorConfigSchema` (line 169) with it; extract shared `CLI_HARNESS_EXECUTOR_TYPES = ['claude_cli','kimi','deepseek_api']` constant and switch BOTH `superRefine` conditionals (line 248 deprecated-`repository` check, line 291 `allowedTools` fallback) from the hardcoded `!== 'claude_cli' && !== 'kimi'` pairs to membership in it (spec FR-016); `'deepseek_api'` is already in `EXECUTOR_TYPES` (22) — do not duplicate
- [X] T004 [P] Contract unit tests for the deepseek_api API branch in `packages/contracts/src/executor.schema.spec.ts`: full error matrix from `contracts/deepseek-executor-api.md` — accepts harness knobs; create-without-key rejected; `auth`, `aws_region`/`aws_profile`/`ca_bundle_path`, and base-URL-like fields rejected as foreign; update variants (omit-keeps, null-clear passes schema); shared constants exported with expected membership
- [X] T005 [P] Contract unit tests for `DeepseekExecutorConfigSchema` + consolidated superRefine in `packages/contracts/src/agents-config.schema.spec.ts`: deepseek accepted in the union (typed, no longer passthrough — junk fields now rejected); `repository`/`allowedTools` cross-checks fire for deepseek exactly as for claude_cli/kimi; existing claude_cli/kimi accept/reject outcomes unchanged by the constant extraction (SC-002 guard)
- [X] T006 In `libs/executors/src/claude-cli/claude-cli.config.ts`: add `DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'` beside `MOONSHOT_ANTHROPIC_BASE_URL` (line 17) with a twinned doc comment (Constitution static-structure carve-out, per `contracts/deepseek-provider-env.md`); `applyProviderEnv` (line 171) needs NO change — verify it stays preset-generic
- [X] T007 In `libs/executors/src/claude-cli/claude-cli.executor.ts`: generalize the api_key-only keyless guard (line 776, currently `if (this.preset.type === 'kimi')`) to a membership check against the shared `API_KEY_ONLY_EXECUTOR_TYPES` set imported from `@brigadir/contracts` — one check, NOT a second `if`; parameterize the error message per type ("re-enter the DeepSeek key…" for deepseek_api, existing Moonshot wording preserved for kimi)
- [X] T008 In `libs/executors/src/executors.module.ts`: add module-private `DEEPSEEK_EXECUTOR = Symbol('DEEPSEEK_EXECUTOR')` provider with `useFactory` building `new ClaudeCliExecutor(db, agentsConfig, jira, { type: 'deepseek_api', anthropicBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL })`, `inject: [DRIZZLE, AGENTS_CONFIG, JIRA_CLIENT]` (mirror of KIMI_EXECUTOR, lines 19/38–46); append to the `AGENT_EXECUTORS` factory array (48–55). Registry-only — no subclass, no class-token resolution
- [X] T009 [P] Unit tests for `applyProviderEnv` with the deepseek preset in `libs/executors/src/claude-cli/claude-cli.config.spec.ts`: deepseek preset ⇒ `ANTHROPIC_BASE_URL` = DeepSeek constant; kimi preset still ⇒ Moonshot constant; claude_cli preset ⇒ key entirely absent; purity (no `process.env` reads)
- [X] T010 [P] Unit tests for the generalized keyless guard in `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`: keyless deepseek_api profile → loud error naming the profile and DeepSeek (normal failed-run path, no host_subscription fallback); keyless kimi message unchanged; claude_cli defaulting chain untouched
- [X] T011 [P] Unit tests for module/registry in `libs/executors/src/executors.module.spec.ts`: `AGENT_EXECUTORS` yields the third instance with `type: 'deepseek_api'` carrying the DeepSeek preset; `ExecutorRegistry.resolve('deepseek_api')` returns it; `resolve('claude_cli')` / `resolve('kimi')` unchanged
- [X] T012 [P] Queue materialization assertion in `libs/queues/src/queues.module.spec.ts`: provisioned set now includes `run.deepseek_api` (extend the existing set assertion, lines 11–17); no `queues.module.ts` code change
- [X] T013 Rebuild the contracts dist so web/backend resolve the new schema: `pnpm --filter @brigadir/contracts build` (repository root; memory: merged-≠-deployed dist trap)

**Checkpoint**: `pnpm typecheck && pnpm test` green (including untouched claude_cli/kimi suites) — user story phases can begin.

---

## Phase 3: User Story 1 — Runs execute on DeepSeek models, configured entirely from the dashboard (Priority: P1) 🎯 MVP

**Goal**: A deepseek_api profile created via API/dashboard produces end-to-end runs through `run.deepseek_api` against the DeepSeek endpoint with the profile's key — shared harness behavior otherwise identical.

**Independent Test**: Create deepseek_api profile via API only, attach agent, trigger run → run attributed `deepseek_api`, travels `run.deepseek_api`, child env has DeepSeek base URL + profile key, completes with schema-valid report (fake-claude harness).

- [X] T014 [US1] Create `apps/worker/src/deepseek-run.processor.ts` — clone of `kimi-run.processor.ts`: `@Processor(runQueueName('deepseek_api'), { concurrency: 2, maxStalledCount: 0, settings: { backoffStrategy }, autorun: false })`, `class DeepseekRunProcessor extends ClaudeCliRunProcessor` with `protected override readonly executorType: string = 'deepseek_api'`; doc comment mirrors kimi's (composition-time queue-name read is documented static structure)
- [X] T015 [US1] Register `DeepseekRunProcessor` in `apps/worker/src/app.module.ts` (import beside KimiRunProcessor line 15; providers entry beside the kimi one ~line 54)
- [X] T016 [US1] Wire the processor into the worker lock in `apps/worker/src/worker-lock.bootstrap.ts`: inject `DeepseekRunProcessor` in the constructor (line 35 area) and include `this.deepseekProcessor.worker` in `workers()` (line 44 area) — WITHOUT this the queue is provisioned but never consumed (feature 027 `autorun: false` gating; research D6)
- [X] T017 [US1] Extend `apps/backend/src/dashboard/executors.controller.ts` to deepseek_api via the shared contracts guards (NOT third literals): update-side must-end-with-key rule (lines 103, 117 — per-type 422 message "deepseek_api requires a stored or provided api_key."), `apiKey` extraction (131), insert-values mapping (215), `sealApiKey` guard (237), response mapping with no computed `auth` (268); NO seeding changes (`executor-seed.ts` untouched)
- [X] T018 [US1] Integration test `test/integration/deepseek-run.spec.ts` (mirror `kimi-run.spec.ts`, unique `BULLMQ_PREFIX`): deepseek profile → agent → triggered run travels `run.deepseek_api`; fake-claude-captured child env contains `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and the profile's decrypted key (contract invariant 3); run completes with schema-valid report using `test/fixtures/claude-cli/stream-success.ndjson`
- [X] T019 [P] [US1] Failure-parity integration cases in `test/integration/deepseek-run.spec.ts`: rate-limit (`stream-rate-limit.ndjson`) and no-report/crash (`stream-no-report.ndjson`) fixtures produce the same run statuses/diagnostics as claude_cli equivalents (SC-009); keyless-at-runtime deepseek profile fails fast through the normal failed-run path with the per-type message
- [X] T020 [P] [US1] Integration test `test/integration/deepseek-executor-crud.spec.ts` (mirror `kimi-executor-crud.spec.ts`): live-API matrix from `contracts/deepseek-executor-api.md` — create-without-key 422, foreign fields (auth/aws/base-url) 422, key retained on key-omitting update, clear-to-keyless 422, `has_api_key` in responses, key never echoed (SC-008)
- [X] T021 [P] [US1] Integration test `test/integration/deepseek-gate.spec.ts` (mirror `kimi-gate.spec.ts`): per-profile `max_parallel_runs` admission (`at_capacity`/`disabled` verdicts) and live concurrency re-apply on `run.deepseek_api`

**Checkpoint**: US1 independently deliverable — deepseek runs work end-to-end via API (fake harness). MVP complete.

---

## Phase 4: User Story 2 — Existing executor types are completely unaffected (Priority: P1)

**Goal**: claude_cli AND kimi behavior byte-identical; suites of features ≤027 pass without modification.

**Independent Test**: Full existing unit + integration suites green with zero edits; captured claude_cli child env has no endpoint override; kimi child env carries exactly Moonshot.

- [X] T022 [US2] Per-preset regression unit assertions in `libs/executors/src/claude-cli/claude-cli.executor.spec.ts` / `claude-cli.config.spec.ts`: with the claude_cli preset the assembled child env has NO `ANTHROPIC_BASE_URL` key in all three auth modes; with the kimi preset it is exactly the Moonshot constant (never DeepSeek); existing `__snapshots__/` unchanged
- [X] T023 [US2] Integration regression companions in `test/integration/deepseek-run.spec.ts`: spawn claude_cli and kimi runs in the same suite/config and assert the claude_cli child env contains no `ANTHROPIC_BASE_URL` and neither contains any DeepSeek-derived value
- [X] T024 [US2] Run the complete pre-existing corpus untouched: `pnpm test && pnpm test:integration`; verify via `git diff --name-only` that no `*.spec.ts` / `__snapshots__` files of features ≤027 are modified beyond the files this feature's tasks explicitly extend (repository root; SC-002)

**Checkpoint**: SC-002 satisfied — regression floor holds.

---

## Phase 5: User Story 4 — Security floor: host environment can never leak into deepseek_api runs (Priority: P2)

**Goal**: Host env pollution stripped for every type; injection sourced only from constant + profile row; allowlist unchanged; key scrubbed everywhere.

**Independent Test**: Polluted worker shell (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` exported) → zero host values in any child env; deepseek child has exactly constant URL + profile key.

- [X] T025 [P] [US4] Extend the allowlist-floor negative assertions in `libs/executors/src/claude-cli/env-allowlist.spec.ts` (they exist from 025 — verify they still lock `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`OPENAI_*` out and add none are needed for deepseek); `env-allowlist.ts` itself must have NO diff in this feature
- [X] T026 [US4] Integration test `test/integration/deepseek-security.spec.ts` (mirror `kimi-security.spec.ts`): with worker process env polluted by host `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, a deepseek run's child env contains the DeepSeek constant + profile key only; claude_cli child contains none; kimi child keeps exactly Moonshot; key absent from argv, logs, timeline and diagnostics (env scrubber masks it — invariants 1–5 of `contracts/deepseek-provider-env.md`; SC-003, SC-006 automated half)

**Checkpoint**: SC-003 satisfied.

---

## Phase 6: User Story 5 — Provider attribution on runs is immutable and analytics-friendly (Priority: P3)

**Goal**: `runs.executor_type='deepseek_api'` written at creation, never rewritten by profile edits; single-filter analytics.

**Independent Test**: Execute deepseek runs, edit profile (rename/model), verify history still `deepseek_api` and selectable by one equality filter.

- [X] T027 [US5] Attribution integration cases in `test/integration/deepseek-run.spec.ts`: created run rows have `executor_type='deepseek_api'`; after profile updates (name/model via API) historical rows unchanged; `WHERE executor_type='deepseek_api'` selects exactly the DeepSeek-backed runs in a mixed history (SC-007); run list/detail API exposes the type

**Checkpoint**: SC-007 satisfied. (No implementation task expected — attribution is existing denormalization; this phase proves it.)

---

## Phase 7: User Story 6 — The dashboard form guides the operator per type (Priority: P3)

**Goal**: deepseek_api in the type selector with exactly the harness field set (key block unconditional, no URL/auth/AWS fields, no Clear-key); model hint with native ids + both caveats; indicative-cost marker on deepseek runs.

**Independent Test**: Open form → select deepseek_api → verify visible fields, absences, and hint; save without key rejected; run views show indicative marker for deepseek cost.

- [X] T028 [US6] Extend `apps/web/src/components/ExecutorForm/ExecutorForm.vue`: add `deepseek_api` el-option (line 193); switch `isCliHarness` (60) and `showApiKey` (64) to the shared contracts guards (deepseek shows the key block unconditionally); extend the config-build branch (102–108), create-time key-required pre-check (158–161, message "A DeepSeek API key is required…"), no-Clear-button rule (249), and `sk-...` placeholder (264); add the model hint (`data-test="deepseek-model-hint"`, pattern of line 206): native ids `deepseek-v4-pro` / `deepseek-v4-flash`, cost indicative (Anthropic price list), unrecognized names silently routed to the cheapest model
- [X] T029 [P] [US6] Labels/markers in the views: `apps/web/src/views/settings/SettingsExecutors.vue` — deepseek_api joins the first-class (non-muted) type styling (line 68); `apps/web/src/views/RunCard.vue` — indicative-cost marker condition covers `executor_type === 'deepseek_api'` (line 116) with a provider-aware tooltip (119); `apps/web/src/views/Runs.vue` — same in the cost column (250–251). Styling via `var(--el-color-*)` only; icons static per UI conventions
- [X] T030 [P] [US6] Web component tests: extend `apps/web/test/executor-form.spec.ts` (deepseek field set, hint presence, absences of auth/AWS/URL/Clear, key-required validation, request payload shape) and `apps/web/test/run-card.spec.ts` + `apps/web/test/runs-table.spec.ts` (indicative marker shown for deepseek runs, absent for claude_cli)

**Checkpoint**: Story 6 acceptance scenarios + FR-013/FR-014 UI half satisfied. Run full gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` — all green before Phase 8.

---

## Phase 8: User Story 3 — Live smoke against the real DeepSeek API (Priority: P1 — definition of done; gated on green Phase 7 checkpoint)

**Goal**: One real run proves the callback-channel hypothesis (client-side stdio MCP works against DeepSeek), model-id pass-through, tool use, and cost/usage behavior. **Stop condition applies** (spec Story 3 scenario 4).

**Independent Test**: Minimal real run through a fresh deepseek_api profile with callback channel on; timeline inspected for evidence.

- [X] T031 [US3] Bring up the stack in dev mode per `docs/local-setup.md`; create the smoke profile via `POST /api/executors` (or UI): `type: "deepseek_api"`, `model: "deepseek-v4-flash"`, real `api_key` in the request body ONLY (write-only → sealed; NEVER committed / in `.env` / in spec files / in logs), `use_callback_channel: true`, `max_parallel_runs: 1`; execute one minimal run in a test workspace (repository root)
- [X] T032 [US3] Verify smoke acceptance evidence per `contracts/deepseek-provider-env.md` §Smoke: (a) terminal status via the normal path, NOT fail-closed; (b) callback events (`report_progress → Brigadir`) on the timeline — if ABSENT: STOP, write up symptoms, apply no workaround (feature decision changes); (c) tool use — files read/written in the worktree; (d) configured `deepseek-v4-flash` confirmed as the serving model via usage/response logs — if silently remapped, document the observed convention in `specs/028-deepseek-executor/contracts/deepseek-provider-env.md` and correct the form hint in `ExecutorForm.vue`; (e) `cost_usd`/usage populated OR absence documented as a known limitation in the same contract + `docs/architecture.md` §4 (SC-004, SC-005)
- [X] T033 [US3] Post-smoke key-leak audit: inspect the run timeline, diagnostics, and worker logs for the smoke key — must appear nowhere (scrubber masks it, mirroring `deepseek-security.spec.ts` assertions manually); confirm the key exists only in the sealed `executors.secrets` blob (SC-006)

**Checkpoint**: SC-001, SC-004, SC-005, SC-006 satisfied — feature definition of done met (or stop-condition report written).

---

## Phase 9: Polish & Cross-Cutting

**Purpose**: Docs, final validation, journal.

- [X] T034 [P] Update `docs/architecture.md` §4: add deepseek_api to the executor-type union/table (Механика = Claude CLI harness against DeepSeek's Anthropic-compatible endpoint `https://api.deepseek.com/anthropic`; Auth = DeepSeek API key BYOK via profile, implicitly api_key-only; cost_usd = indicative, Anthropic price list; native model ids + silent-substitution note; smoke findings incl. usage/cost behavior)
- [X] T035 [P] Append the iteration entry to `docs/progress.md`: feature 028, decisions summary (third provider preset, FR-016 shared type-set constants, worker-lock registration, no seeding, indicative cost), smoke results incl. the callback-channel verdict, test coverage, zero-DDL note
- [X] T036 Execute `specs/028-deepseek-executor/quickstart.md` V1–V4 end-to-end and confirm the SC done-check table (V5 already done as Phase 8); fix anything surfaced before closing the iteration (repository root). **Status**: V1 (typecheck+lint+unit, 308 web / full unit corpus) and V2+V4 (`pnpm test:integration`, 104 files / 438 tests incl. the 4 deepseek suites) GREEN; snapshots untouched, no pre-028 spec files modified beyond the explicitly extended ones. V3 (manual dashboard walk on `docker compose up`) not run in this session — port 3000 is occupied by the operator's live dev stack; every V3 check is covered by automation (executor-form/run-card/runs-table component tests, deepseek-executor-crud live-API matrix) plus the V5 live smoke, and can be repeated manually on the operator's stand at will. V5 (live smoke) PASSED — callback-channel hypothesis confirmed; `cost_usd`/`usage` NULL documented as a known limitation.

---

## Dependencies & Execution Order

```text
Phase 1 (T001)
  └─► Phase 2 Foundational (T002–T013)
        T002 ∥ T003 ─► T004 ∥ T005
        T002 ─► T006 ─► T007 ─► T008 ─► T009 ∥ T010 ∥ T011 ∥ T012
        T002+T003 ─► T013 (dist rebuild; before any web work)
        └─► Phase 3 US1 (T014–T021)  ← MVP; T014─►T015─►T016; T017 ∥ T014; T018 after T014–T017; T019/T020/T021 after T018 scaffolding [P]
              ├─► Phase 4 US2 (T022–T024)  ← T022 [P] with US1 tests; T024 last in phase
              ├─► Phase 5 US4 (T025–T026)  ← T025 [P] anytime after Phase 2; T026 after T014–T016
              ├─► Phase 6 US5 (T027)       ← after T018
              └─► Phase 7 US6 (T028–T030)  ← after T013 (dist) + T017 (API); independent of worker tasks
                    └─► Phase 8 US3 smoke (T031─►T032─►T033)  ← ONLY after the Phase 7 full-gates checkpoint
                          └─► Phase 9 Polish (T034 ∥ T035 ─► T036)
```

- **US1 → US2/US4/US5**: the invariant stories need a working deepseek path to test against; US2's unit part (T022) only needs Phase 2.
- **US6** depends only on Phase 2 contracts + dist rebuild + T017 (controller) — can proceed in parallel with worker/integration work.
- **US3 (smoke)** is strictly terminal among stories: spec gates it on green quality gates; T034/T035 consume its findings.

## Parallel Execution Examples

- After T002+T003: `T004 ∥ T005` (different spec files) while `T006→T007→T008` proceeds.
- After Phase 2: `T009 ∥ T010 ∥ T011 ∥ T012 ∥ T025` (five different spec files).
- After T018: `T019 ∥ T020 ∥ T021 ∥ T027` (separate suites/cases) and `T028→T029/T030` on the web side simultaneously.
- Docs `T034 ∥ T035` once smoke findings exist.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: deepseek runs work end-to-end via API with tests against the fake harness. US2/US4 invariants are structurally guaranteed by the Phase 2 design (preset-scoped injection, untouched allowlist, shared constants that cannot diverge) — their phases add the *proof*. The feature is NOT done at MVP: spec FR-017 makes the Phase 8 smoke (callback-channel hypothesis) part of the definition of done, with an explicit stop condition instead of a workaround if it fails. Single-PR flow per constitution: land phases sequentially on this branch, keeping the suite green at every checkpoint; US6 (web) can proceed in parallel after Phase 2 + T013 + T017. Total: **36 tasks**.
