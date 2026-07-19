# Tasks: First-class kimi executor type (Moonshot AI backend)

**Input**: Design documents from `/specs/025-kimi-executor/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — all present.

**Tests**: MANDATORY for everything here except the pure-UI tasks (constitution Principle VI — executor lifecycle, enqueue, callbacks are pipeline logic). Test tasks are placed in the same phase as the functionality they cover.

**Organization**: Grouped by user story from spec.md. US1 (kimi runs e2e) and US2 (claude_cli untouched) are both P1 — US2 is a regression-invariant story whose guarantees are baked into Foundational design and verified by dedicated tasks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 per spec.md

## Path Conventions

Monorepo per plan.md: `libs/executors/`, `packages/contracts/`, `libs/queues/` (no changes), `apps/worker/`, `apps/backend/`, `apps/web/`, `test/integration/`, `docs/`.

---

## Phase 1: Setup

**Purpose**: Baseline verification — no scaffolding needed (no new packages, no DDL).

- [X] T001 Verify green baseline before any edits: run `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration`; record any pre-existing failures in the PR description so they are not attributed to this feature (repository root)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Type registration, contracts, and the parameterized executor — every user story depends on these.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Add `'kimi'` to interface-layer `EXECUTOR_TYPES` in `libs/executors/src/agent-executor.interface.ts` (lines 7–13; `ExecutorType` union picks it up automatically)
- [X] T003 [P] Add `'kimi'` to config-layer `EXECUTOR_TYPES` (lines 16–22) and to `RUN_QUEUE_EXECUTOR_TYPES` (line 32 — this provisions the `run.kimi` BullMQ queue via `libs/queues/src/queues.module.ts`, no queue-module edits) in `packages/contracts/src/agents-config.schema.ts`
- [X] T004 Add `KimiExecutorConfigSchema` (camelCase stored shape, `.strict()`) to the `ExecutorConfigSchema` discriminated union (lines 127–133) in `packages/contracts/src/agents-config.schema.ts` — clone of `ClaudeCliExecutorConfigSchema` minus `auth`/`awsRegion`/`awsProfile`/`caBundlePath` and minus the bedrock superRefine; extend both claude_cli cross-field `superRefine` checks (deprecated `repository` match ~line 210, `allowedTools` fallback ~line 253) to also cover `executor.type === 'kimi'`
- [X] T005 Add `'kimi'` to `ExecutorTypeSchema` (line 44), add `KimiExecutorApiConfigSchema` (snake_case, `.strict()`, `api_key` write-only nullable-optional) to `ExecutorApiConfigSchema`, `ExecutorCreateRequestSchema` (with kimi key-required-on-create refinement mirroring lines 157–165) and `ExecutorUpdateRequestSchema` (lines 173–177) in `packages/contracts/src/executor.schema.ts` — per `contracts/kimi-executor-api.md`
- [X] T006 [P] Contract unit tests for the kimi API branch in `packages/contracts/src/executor.schema.spec.ts`: full error matrix from `contracts/kimi-executor-api.md` (accepts harness knobs; rejects missing key on create; rejects `auth`, `aws_*`, base-URL-like fields; update variants)
- [X] T007 [P] Contract unit tests for `KimiExecutorConfigSchema` + extended superRefine coverage in `packages/contracts/src/agents-config.schema.spec.ts` (kimi accepted in union; repository/allowedTools cross-checks fire for kimi like for claude_cli)
- [X] T008 Define `MOONSHOT_ANTHROPIC_BASE_URL = 'https://api.moonshot.ai/anthropic'` constant and `ProviderPreset` type (`{ type: ExecutorType; anthropicBaseUrl?: string }`), and add pure `applyProviderEnv(env, preset)` beside `applyAuthEnv` (lines 118–136) in `libs/executors/src/claude-cli/claude-cli.config.ts`; document the composition-time constant as static structure at the definition site (per `contracts/kimi-provider-env.md`)
- [X] T009 Parameterize `ClaudeCliExecutor` with the constructor `ProviderPreset`: replace `readonly type = 'claude_cli' as const` (line 164) with preset-sourced `readonly type`; in `loadRunConfig` (lines 562–746) resolve kimi-preset auth unconditionally to `{mode:'api_key'}` requiring sealed secrets (fail-fast run failure if absent); in `runProcess` call `applyProviderEnv(env, preset)` after `applyAuthEnv` (line 385) before `spawnGroup` (line 386) in `libs/executors/src/claude-cli/claude-cli.executor.ts`
- [X] T010 Register two DI instances in the `AGENT_EXECUTORS` factory (lines 20–26) in `libs/executors/src/executors.module.ts`: `claude_cli` preset (no base URL) and `kimi` preset (`MOONSHOT_ANTHROPIC_BASE_URL`) — both via `useFactory` with the executor's DI deps (`DRIZZLE`, `AGENTS_CONFIG`, `JIRA_CLIENT`); `MockExecutor` unchanged
- [X] T011 [P] Unit tests for `applyProviderEnv` per preset in `libs/executors/src/claude-cli/claude-cli.config.spec.ts`: kimi preset ⇒ `ANTHROPIC_BASE_URL` = constant; claude_cli preset ⇒ key absent from env object; function is pure (no `process.env` reads); polluted source env never contributes the value
- [X] T012 [P] Unit tests for module/registry in `libs/executors/src/` (extend `claude-cli.executor.spec.ts` or add `executors.module.spec.ts`): `AGENT_EXECUTORS` factory yields both instances with correct `type`; `ExecutorRegistry.resolve('kimi')` returns the Moonshot-preset instance; `resolve('claude_cli')` unchanged

**Checkpoint**: `pnpm typecheck && pnpm test` green (including untouched claude_cli suites) — user story phases can begin.

---

## Phase 3: User Story 1 — Runs execute on Moonshot Kimi models, configured entirely from the dashboard (Priority: P1) 🎯 MVP

**Goal**: A kimi profile created via API/dashboard produces end-to-end runs through `run.kimi` against the Moonshot endpoint with the profile's key — shared harness behavior otherwise identical.

**Independent Test**: Create kimi profile via API only, attach agent, trigger run → run attributed `kimi`, travels `run.kimi`, child env has Moonshot base URL + profile key, completes with schema-valid report (fake-claude harness).

- [X] T013 [US1] Create `apps/worker/src/kimi-run.processor.ts`: `@Processor(runQueueName('kimi'), { concurrency: 2, maxStalledCount: 0, settings: { backoffStrategy } })` sharing `ClaudeCliRunProcessor` logic (extract shared base in `apps/worker/src/claude-cli-run.processor.ts` or near-copy — whichever keeps claude_cli behavior byte-identical per research.md D6); wire `applyExecutorConcurrency`/`startConcurrencyReapply` with `executorType: 'kimi'` in `onApplicationBootstrap`; keep `checkExecutorGate` admission
- [X] T014 [US1] Register `KimiRunProcessor` in providers (line 44) in `apps/worker/src/app.module.ts`
- [X] T015 [US1] Extend snake↔camel mappers and key rules for `type === 'kimi'` in `apps/backend/src/dashboard/executors.controller.ts`: `toInsertValues` (lines 191–214, kimi field pairs minus auth/aws), `toExecutorResponse` (lines 223–260, no computed `auth` for kimi, keep `has_api_key`), `sealApiKey` create path, update-side must-end-with-key rule (lines 100–117) applied to kimi; NO changes to `apps/backend/src/dashboard/executor-seed.ts` (clarified: no kimi seeding)
- [X] T016 [US1] Integration test `test/integration/kimi-run.spec.ts` (mirror `claude-cli-bedrock.spec.ts` + `claude-cli-harness.ts` patterns, unique `BULLMQ_PREFIX`): kimi profile → agent → triggered run goes through `run.kimi`; fake-claude-captured child env contains `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic` and the profile's decrypted key; run completes with schema-valid report using `test/fixtures/claude-cli/stream-success.ndjson`
- [X] T017 [P] [US1] Integration test failure parity in `test/integration/kimi-run.spec.ts` (or sibling file): rate-limit (`stream-rate-limit.ndjson`) and no-report/crash (`stream-no-report.ndjson`) fixtures on a kimi run produce the same run statuses/diagnostics as claude_cli equivalents (SC-005); keyless-at-runtime kimi profile fails fast through the normal failed-run path
- [X] T018 [P] [US1] Integration test `test/integration/kimi-executor-crud.spec.ts` (mirror `executor-crud.spec.ts` / `executor-api-key.spec.ts`): create/update/response matrix from `contracts/kimi-executor-api.md` over the live API — create-without-key 422, foreign fields 422, key retained on update, clear-to-keyless 422, `has_api_key` in responses, key never echoed
- [X] T019 [P] [US1] Integration test gate/concurrency on `run.kimi` in `test/integration/kimi-gate.spec.ts` (mirror `executor-gate.spec.ts`): per-profile `max_parallel_runs` admission (`at_capacity`/`disabled` verdicts) and live concurrency re-apply for kimi profiles

**Checkpoint**: US1 independently deliverable — kimi runs work end-to-end via API. MVP complete.

---

## Phase 4: User Story 2 — Existing Claude CLI profiles and runs are completely unaffected (Priority: P1)

**Goal**: claude_cli behavior byte-identical; suites of features ≤024 pass without modification.

**Independent Test**: Full existing unit + integration suites green with zero edits; captured claude_cli child env identical to pre-feature baseline.

- [X] T020 [US2] Per-preset regression unit test in `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`: with the claude_cli preset the assembled child env object is deep-equal to the pre-feature construction for all three auth modes (`host_subscription`/`api_key`/`bedrock`) — in particular the `ANTHROPIC_BASE_URL` key is entirely absent; existing `__snapshots__/` must not change
- [X] T021 [US2] Integration regression assertion in `test/integration/kimi-run.spec.ts` (companion case): spawn a claude_cli run in the same suite/config as the kimi run and assert its child env contains no `ANTHROPIC_BASE_URL` and no kimi-derived values
- [ ] T022 [US2] Run the complete pre-existing test corpus untouched and verify zero modified test files of features ≤024: `pnpm test && pnpm test:integration`; `git diff --name-only` contains no `*.spec.ts` / `__snapshots__` edits outside files newly added or explicitly extended by this feature's tasks (repository root)

**Checkpoint**: SC-002 satisfied — regression floor holds.

---

## Phase 5: User Story 4 — Security floor: host environment can never leak into kimi runs (Priority: P2)

**Goal**: Host env pollution stripped for every type; injection sourced only from constant + profile row; allowlist unchanged.

**Independent Test**: Polluted worker shell (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` exported) → zero host values in any child env; kimi child has exactly constant URL + profile key.

- [X] T023 [P] [US4] Unit guard in `libs/executors/src/claude-cli/env-allowlist.spec.ts`: assert `ALLOWLIST_KEYS` does NOT contain `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`OPENAI_*` (lock the floor with an explicit negative test); `env-allowlist.ts` itself must have no diff in this feature
- [X] T024 [US4] Integration test `test/integration/kimi-security.spec.ts` (mirror `claude-cli-security.spec.ts`): with worker process env polluted by host `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, a kimi run's child env contains the Moonshot constant + profile key only (host values absent), and a claude_cli run's child env contains none of them; secrets absent from argv and logs (invariants 1–5 of `contracts/kimi-provider-env.md`)

**Checkpoint**: SC-003 satisfied.

---

## Phase 6: User Story 3 — Provider attribution on runs is immutable and analytics-friendly (Priority: P2)

**Goal**: `runs.executor_type='kimi'` written at creation, never rewritten by profile edits; single-filter analytics.

**Independent Test**: Execute kimi runs, edit profile (rename/model), verify history still `kimi` and selectable by one equality filter.

- [X] T025 [US3] Integration test in `test/integration/kimi-run.spec.ts` (attribution cases): created kimi run rows have `executor_type='kimi'`; after updating the profile (name/model via API) historical run rows are unchanged; `WHERE executor_type='kimi'` returns exactly the Moonshot-backed runs in a mixed mock/claude_cli/kimi history (SC-004); run list/detail API exposes `executor_type='kimi'`

**Checkpoint**: SC-004 satisfied. (No implementation task expected — attribution is existing denormalization; this phase proves it. If the test reveals a type-hardcoded gap in run creation/enqueue, fix it within this task's scope.)

---

## Phase 7: User Story 5 — Dashboard form guides the operator per type (Priority: P3)

**Goal**: kimi in the type selector with exactly the kimi field set; no URL/auth-mode/AWS fields; key required on create; indicative-cost marker on kimi runs.

**Independent Test**: Open form → select kimi → verify visible fields and absences; save without key rejected; run views show indicative marker for kimi cost.

- [X] T026 [US5] Add `kimi` option to the type selector (`data-test="executor-type"`, lines 152–157) and a kimi conditional field block (model, api_key, max_parallel_runs, cli_path, use_callback_channel, keep_failed_worktrees, max_turns; NO url field, NO auth selector `data-test="executor-auth"`, NO aws fields) with key-required-on-create form validation, extending `buildRequest()` (lines 83–121) in `apps/web/src/components/ExecutorForm/ExecutorForm.vue`
- [X] T027 [P] [US5] Indicative-cost marker (tooltip/суффикс «indicative», styled via `var(--el-color-*)` only, lucide icon static per UI conventions) when `executor_type === 'kimi'` in `apps/web/src/views/RunCard.vue` (`meta-cost`, ~line 197) and the cost column of `apps/web/src/views/Runs.vue` (~line 193)
- [X] T028 [P] [US5] Component/unit tests for the kimi form branch (visible/hidden fields, key-required validation, request payload shape) alongside existing ExecutorForm tests in `apps/web/src/components/ExecutorForm/` (UI story — lighter coverage permitted, but form→request mapping feeds the pipeline contract, so payload shape is asserted)

**Checkpoint**: Story 5 acceptance scenarios + FR-013/FR-014 UI half satisfied.

---

## Phase 8: Polish & Cross-Cutting

**Purpose**: Docs, final validation, journal.

- [ ] T029 [P] Update `docs/architecture.md` §4: add `kimi` to the interface `type` union (line 375), add a kimi column to the «Реализации» table (lines 385–392: Механика = claude CLI harness against Moonshot Anthropic-compatible endpoint; Auth = Moonshot API key BYOK via profile; cost_usd = indicative, Anthropic price list) and the env-injection note; optionally align the queue-naming line 341 with runtime `run.<type>` naming
- [ ] T030 [P] Add iteration entry to `docs/progress.md`: feature 025, decisions summary (first-class type, provider preset, no seeding, indicative cost), test coverage, zero-DDL note
- [ ] T031 Execute `specs/025-kimi-executor/quickstart.md` V1–V4 in full (V3 manual dashboard pass against `docker compose up --build`); confirm the SC done-check table; fix anything surfaced before closing the iteration (repository root)

---

## Dependencies & Execution Order

```text
Phase 1 (T001)
  └─► Phase 2 Foundational (T002–T012)
        T002, T003 ─► T004 ─► T005 ─► T006, T007
        T002 ─► T008 ─► T009 ─► T010 ─► T011, T012
        └─► Phase 3 US1 (T013–T019)   ← MVP; T013─►T014; T015 ∥ T013; T016 after T013–T015; T017–T019 after T016 scaffolding [P]
              ├─► Phase 4 US2 (T020–T022)  ← T020 [P] with US1 tests; T022 last in phase
              ├─► Phase 5 US4 (T023–T024)  ← T023 [P] anytime after Phase 2; T024 after T013
              ├─► Phase 6 US3 (T025)       ← after T016
              └─► Phase 7 US5 (T026–T028)  ← after T005 (schema) + T015 (API); independent of worker tasks
                    └─► Phase 8 Polish (T029–T031)
```

- **US1 → US2/US3/US4**: the invariant stories need a working kimi path to test against; US2's unit part (T020) only needs Phase 2.
- **US5** depends only on Phase 2 contracts + T015 (controller) — can proceed in parallel with worker/integration work.
- **T031** is terminal (after everything).

## Parallel Execution Examples

- After T003+T005: `T006 ∥ T007` (different spec files) while `T008→T009` proceeds.
- After Phase 2: `T011 ∥ T012 ∥ T023` (three different spec files).
- After T016: `T017 ∥ T018 ∥ T019 ∥ T025` (separate integration suites/cases) and `T026→T027/T028` on the web side simultaneously.
- Docs `T029 ∥ T030` anytime after implementation stabilizes.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: kimi runs work end-to-end via API with tests. US2/US4 invariants are structurally guaranteed by the Phase 2 design (preset-scoped injection, untouched allowlist) — their phases add the *proof*. Recommended single-PR flow per constitution (one iteration): land phases sequentially on this branch, keeping the suite green at every checkpoint; US5 (web) can be developed in parallel by the same or second contributor after Phase 2. Total: **31 tasks**.
