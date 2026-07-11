---
description: "Task list for Jira Core — The Orchestrator Replaces Jira Automation"
---

# Tasks: Jira Core — The Orchestrator Replaces Jira Automation

**Input**: Design documents from `/specs/002-jira-core/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/contracts.md, quickstart.md

**Organization**: Phases follow the plan's **Implementation Phasing** (1–6) exactly. Integration tests live in the same phase as the capability they prove (Constitution VI — no end-of-project test batch). Story labels map to spec.md user stories: **US1** board-driven orchestration loop (P1), **US2** guaranteed ingest / no lost events (P1), **US3** rate-limit-safe correct Jira writes (P2), **US4** self-healing runs (P2), **US5** live smoke (P3), **US6** board-type-aware ingest scope (P1), **US7** dependency-gated triggering (P2).

**Task IDs continue from iteration 1** (which ended at T033) so T-numbers stay unique across the project's progress journal and reviews. This iteration is **T034–T071**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task in the same/earlier phase
- **[Story]**: US1–US7 where the task serves a specific user story; setup/foundational/ops tasks carry no story label
- Every task names its **Verify:** step (command or concrete check)

## Path Conventions

Monorepo root = repository root. New libs this iteration: `libs/jira`, `libs/ingest`, `libs/pipeline`; extended: `libs/database`, `libs/app-config`, `packages/contracts`, `apps/worker`, `apps/backend`, `test/integration/`, `drizzle/` — per plan.md "Source Code" tree.

---

## Phase 1: Contracts + Config + Migration

**Goal**: the config schema accepts the full documented `docs/spec.md` §0.1 workspace shape, the board-column migration applies and is reviewed against §3, and `workspaces.settings` has typed accessors. **Proves**: US6 config half + FR-039 forward-compat. **⚠️ Migration 0001 + config schema block the seeder and board introspection (phase 2).**

- [X] T034 [P] Add dependencies: `p-queue` (runtime, per-issue write serialization) and `msw` (dev, mock Jira) to root `package.json`. **Verify**: `pnpm install` exits 0; `node -e "require('p-queue')"` and `pnpm -w exec node -e "require('msw/node')"` resolve.
- [X] T035 [P] [US6] Extend `WorkspaceConfigSchema` in `packages/contracts/src/agents-config.schema.ts` (research D12): add `board_id` (int, required), `scope_jql` (optional string), `branch_prefix` (optional string), `repositories` (optional array of `{name, url, default_branch}`); keep `repo`/`default_branch` optional-deprecated for seed back-compat; stays `.strict()`. **Verify**: unit test in `agents-config.schema.spec.ts` — the full §0.1 example (board_id+scope_jql+branch_prefix+repositories) passes; a genuinely unknown key still fails; missing `board_id` fails with the path.
- [X] T036 [P] Add shared types in `packages/contracts/src/`: `WorkspaceSettingsSchema` (`scope_jql?`, `reconcile.high_water_mark?`, `reconcile.active_sprint_id?`), ADF types (`ADFDoc`), and Jira value types (`JiraIssue`, `JiraStatus`, `JiraIssueLink`, `JiraTransition`) per contracts.md C2; export from `src/index.ts`. **Verify**: `pnpm --filter @brigadir/contracts build` exits 0; unit test parses a representative settings blob and rejects a malformed one.
- [X] T037 Add migration `0001_jira_board.sql`: extend `libs/database/src/schema/workspaces.ts` with `jiraBoardId` (integer, nullable) + `jiraBoardType` (text, nullable); run `pnpm drizzle-kit generate` → commit `drizzle/0001_jira_board.sql`. **Verify**: migrator applies 0000+0001 against a throwaway Postgres 16 → `\d workspaces` shows both new columns; existing row survives.
- [X] T038 **[Migration review — same discipline as iteration 1's T014]** Diff `drizzle/0001_jira_board.sql` against `docs/architecture.md` §3 (already updated for board binding); record the result in `drizzle/REVIEW-0001_jira_board.md` (column names/types match `jira_board_id integer` / `jira_board_type text`; no unintended alterations to other columns; nullable to apply on the existing row). Fix + regenerate on any drift. **Verify**: `REVIEW-0001_jira_board.md` committed with an explicit "matches §3" confirmation; integration test asserts a from-scratch migrate leaves the two columns present and all iteration-1 tables intact.
- [X] T039 [P] [US6] Add typed `workspaces.settings` accessors in `libs/database` (get/set high-water mark, active sprint id, scope_jql) validated by `WorkspaceSettingsSchema` — no ad-hoc jsonb access. **Verify**: integration test round-trips settings (set HWM + active_sprint_id + scope_jql → re-read equals written; absent fields return defaults).
- [X] T040 [US6] Extend the config seeder in `libs/app-config/src/config-seeder.ts` to persist `board_id` → `workspaces.jira_board_id` and `scope_jql` → `workspaces.settings` on boot; leave `jira_board_type` null pending introspection (T049); idempotent. **Verify**: integration test `config-seed.spec.ts` — boot with a board-configured valid config ⇒ `jira_board_id` set + `settings.scope_jql` set; re-boot ⇒ no duplicate/rewrite churn.
- [X] T041 [US6] Integration test `test/integration/config-forward-compat.spec.ts`: load + boot the full documented `docs/spec.md` §0.1 example (with `board_id`, `scope_jql`, `branch_prefix`, `repositories[]`); assert startup validation passes and the workspace seeds, with `branch_prefix`/`repositories[]` neither rejected nor required (FR-039). **Verify**: `pnpm test:integration test/integration/config-forward-compat.spec.ts` green (SC-011 config half).

**Checkpoint P1**: `pnpm typecheck` green; documented §0.1 example validates + boots; migration 0001 applies from scratch and is reviewed vs §3.

---

## Phase 2: JiraModule Client Core (Foundational — blocks Phases 3–5)

**Goal**: a typed Jira client over fetch (REST v3 + Agile 1.0) with rate limiter + per-issue write serialization, resolved via `forRootAsync` from the workspace row; and the configurable **mock-Jira helper**. **Proves**: US3 write-safety substrate + US6 board introspection. **⚠️ The mock-Jira helper (T042) blocks every later Jira-facing test; the client (T046/T047) blocks transition discovery (phase 3).**

- [X] T042 Build the configurable mock Jira in `test/integration/mock-jira.ts` (msw node interceptors over fetch) per contracts.md C8 / research D11: `/search/jql` with `nextPageToken` pagination echoing requested `fields`; Agile `board/{id}` + active-sprint endpoints; `/issue/{key}/transitions` GET+POST with **409-on-cue**; **429 + Retry-After** on cue; ADF comment capture; `issuelinks` on issues; in-memory store with drivers (`seedIssue`, `setStatus`, `addBlockedByLink`, `moveBlocker`, `startSprint`, `arm409OnNextTransition`, `arm429`) and asserters (`commentsFor`, `transitionsFor`). **Verify**: a smoke spec drives search/jql two-page pagination + `getBoard` against the helper and asserts the parsed shapes — mock-Jira is usable by all later suites. **⚠️ blocks T048, T052, T056, T057, T064–T068.**
- [X] T043 [P] Define `JiraClient` interface in `libs/jira/src/jira-client.interface.ts` per contracts.md C1 (reads: `searchUpdated`, `getBoard`, `getActiveSprintId`, `getTransitions`; mutations: `transitionTo`, `addComment`) and `libs/jira/src/jira.errors.ts` (`NoTransitionPath`, `JiraAuthError` → maps to `UnrecoverableError`, `JiraRateLimited`). **Verify**: `pnpm nest build` exits 0; errors type-check and export.
- [X] T044 [P] [US3] Implement the rate limiter in `libs/jira/src/rate-limiter.ts` per contracts.md C4 / research D3: token bucket (`JIRA_MAX_RPS`, default 5) + global concurrency cap (default 8); on 429 read `Retry-After` (seconds or HTTP-date) and sleep ≥ that, else expo backoff + jitter capped 5 min; log `RateLimit-Reason`. **Verify**: unit test `rate-limiter.spec.ts` — N calls respect RPS ceiling; a 429 with `Retry-After: 1` delays the retry ≥ ~1s (fake timers).
- [X] T045 [P] [US3] Implement the per-issue write queue in `libs/jira/src/per-issue-write-queue.ts` per contracts.md C4 / research D4: `Map<issueKey, PQueue({concurrency:1})>` with idle eviction. **Verify**: unit test `per-issue-write-queue.spec.ts` — concurrent `run(sameKey, ...)` calls execute strictly one-at-a-time in submission order; different keys overlap.
- [X] T046 [US3] Implement `BasicAuthJiraClient` in `libs/jira/src/basic-auth-jira.client.ts` over native fetch (research D1): basic-auth header from `email:api_token`; `searchUpdated` (`POST /rest/api/3/search/jql`, `nextPageToken` loop, explicit `fields`); `addComment`; Agile `getBoard`, `getActiveSprintId`; mutations composed `perIssue.run(key, () => rateLimiter.schedule(() => fetch(...)))`. **Verify**: integration test against `mock-jira.ts` — pagination returns all pages; the request carries `Authorization: Basic …`; comment POST body is ADF.
- [X] T047 [US3] Implement `JiraModule.forRootAsync` in `libs/jira/src/jira.module.ts` per contracts.md C5 / research D2: `useFactory` resolves site URL + project key + credentials from the `workspaces` row at context init and builds the client — no client construction inside the `@Module()` decorator argument, no env read at import, no localhost fallback (Constitution lazy resolution). **Verify**: integration test builds the client from a seeded workspace and issues one read; a missing-credential workspace throws a clear error; static check/grep confirms no client instantiation in a decorator arg.
- [X] T048 [US3] Integration test `test/integration/jira-client.spec.ts` (uses mock-Jira): per-issue writes serialized under concurrent submission (SC-003); a 429 + `Retry-After` is honored and does **not** fail a run or burn an attempt (SC-004); `/search/jql` `nextPageToken` pagination returns the full set. **Verify**: `pnpm test:integration test/integration/jira-client.spec.ts` green (FR-002–FR-004, FR-012 pagination).
- [X] T049 [US6] Implement board introspection at connect/seed in `apps/backend` (or `libs/app-config`): call `getBoard(board_id)` → set `workspaces.jira_board_type` + project-key validation; inaccessible/unknown board fails the connection with a clear diagnostic (FR-028). **Verify**: integration test — seeding a workspace whose mock board is `scrum` populates `jira_board_type='scrum'`; a board that 404s aborts with a located error. **Depends on T037/T040 (columns+seeder) and T046 (client).**

**Checkpoint P2**: mock-Jira drives all Jira endpoints; client core green (rate limit, per-issue serialization, pagination, DI-from-workspace); board type introspected.

---

## Phase 3: Transition Discovery + ADF Composer (US3)

**Goal**: `transitionTo` discovers transitions at runtime, caches them, retries once on 409, raises `NoTransitionPath`, and no-ops when already in target; `buildRunComment` renders ADF. **Independent test**: drive 409/no-path/already-in-target and snapshot the ADF. **⚠️ Blocks onRunFinished (phase 4).**

- [X] T050 [US3] Implement transition discovery in `libs/jira/src/transition-discovery.ts` per contracts.md C1 / research D5: `transitionTo(issueKey, targetStatusName)` = GET `/transitions` → match `to.name` case-insensitively → POST id; TTL cache (10 min) keyed `project|issuetype|fromStatus`; POST 409 → invalidate + re-discover + retry **once**; no match → throw `NoTransitionPath(ticket, fromStatus, target)`; already in target → no POST (FR-023). Wire into `BasicAuthJiraClient.transitionTo` (through the per-issue queue). **Verify**: unit test `transition-discovery.spec.ts` — cache hit avoids a second GET; TTL expiry re-discovers; match is case-insensitive.
- [X] T051 [P] [US1] Implement the pure ADF composer in `libs/jira/src/adf-composer.ts` per contracts.md C3 / research D6: `buildRunComment(report)` → `panel` (info for success, error otherwise) + summary paragraph + `taskList` of checks (`✅/❌/⚠/⏭` + reason). **Verify**: unit test `adf-composer.spec.ts` — snapshot for success, failure, and needs_human reports; pure (same input → identical output).
- [X] T052 [US3] Integration test transitions in `test/integration/jira-client.spec.ts` (extend, uses mock-Jira `arm409OnNextTransition`): 409 → invalidate + retry once → success; no-path target → `NoTransitionPath` with ticket + both statuses; issue already in target → no POST issued. **Verify**: `pnpm test:integration test/integration/jira-client.spec.ts` green (FR-005–FR-008, FR-023; SC-005).

**Checkpoint P3**: transitions discovered/cached/409-retried/no-path-raised; already-in-target idempotent; ADF snapshots stable.

---

## Phase 4: PipelineModule — onStatusChanged + onRunFinished (US1, US7)

**Goal**: status changes match agents (behind the dependency gate) and enqueue via `RunTriggerService`; run completion transitions the ticket + posts the ADF comment (persist-then-write) — **closes F2**. **Independent test**: full loop on mock Jira for all three outcomes; blocked ticket does not fire. **⚠️ Blocks reconcile steps that emit triggers (phase 5).**

- [X] T053 [P] [US7] Implement `evaluateDependencyGate(issue)` in `libs/pipeline/src/dependency-gate.ts` per research D10: BLOCKED iff any inward "is blocked by" link has `inwardIssue.fields.status.statusCategory.key !== 'done'`; only inward "is blocked by" links gate (not "blocks"/"relates to"). **Verify**: unit test `dependency-gate.spec.ts` — blocked-by open blocker ⇒ blocked; all blockers done ⇒ clear; "relates to"/outward "blocks" ⇒ clear.
- [X] T054 [US1] Implement `PipelineService.onStatusChanged` in `libs/pipeline/src/pipeline.service.ts` per contracts.md C6: match enabled agents by `trigger_status == toStatus`, apply `evaluateDependencyGate`, and for clear ones call `RunTriggerService.trigger(...)` (the existing three dedup layers); gated skips logged with the blocking key. **Verify**: unit/integration — a matching non-gated status change enqueues exactly one run; a gated one enqueues none (logged).
- [X] T055 [US1] Implement `PipelineService.onRunFinished` (per contracts.md C6 / data-model.md write-ordering) and wire it into `apps/worker/src/run.processor.ts` **after** finalize (persist-then-write, FR-022): success → `transitionTo(status_success)` + `addComment(buildRunComment)`; failure/needs_human → `transitionTo(status_failure)` + comment (human_task already created by `RunsService`, no duplicate); optional `status_running` transition at job start; then INSERT `run_events(type='jira_action')` marker. All writes via `JiraClient` only (Principle III). **Verify**: `pnpm nest build worker` exits 0; behavior asserted in T056.
- [X] T056 [US1] Integration test `test/integration/pipeline-loop.spec.ts` (uses mock-Jira): status change → enqueue → mock run → transition + ADF comment for `success` (→ status_success), `failure` and `needs_human` (→ status_failure + comment; needs_human leaves exactly one open human_task); optional `status_running` transition fires at job start; a NoTransitionPath board config → run recorded `failed` with the diagnostic. **Verify**: `pnpm test:integration test/integration/pipeline-loop.spec.ts` green (FR-018–FR-024; SC-001, SC-005; **closes F2**).
- [X] T057 [US7] Integration test (trigger side) `test/integration/dependency-gate.spec.ts`: a ticket in a trigger status with an open "is blocked by" blocker enqueues **no** run; a ticket whose only links are non-blocking fires normally. **Verify**: `pnpm test:integration test/integration/dependency-gate.spec.ts` green for the trigger-side cases (FR-034–FR-035; blocker→Done reconcile case added in T066).

**Checkpoint P4**: full loop transitions + comments for all outcomes; dependency gate blocks triggers; **F2 closed**.

---

## Phase 5: IngestModule — Reconcile Job (US2, US4, US6, US7)

**Goal**: reconcile is one scheduled processor running four ordered, independently try/caught steps sharing one pass-level Jira budget — **closes F3**. **Independent test**: 1-hour catch-up, board scope, scope_jql, dependency re-eval, watchdog, drift repair. **Depends on PipelineModule (phase 4) for the steps that emit triggers.**

- [X] T058 [US2] Implement the poller in `libs/ingest/src/poller.service.ts` per contracts.md C7 / research D7: build kanban/scrum scope JQL + optional `scope_jql` + `updated >= HWM-60s`; `nextPageToken` loop with explicit `fields` (`status,summary,updated,issuelinks`); upsert tickets; diff `last_seen_status` → `onStatusChanged` (scope-entry when `last_seen_status` absent, FR-031); advance + persist HWM (max observed `updated`). **Verify**: integration test — updated tickets since HWM are upserted and diffed; unchanged status emits no trigger; HWM advances and persists.
- [X] T059 [US6] Implement sprint-switch handling in the poller (research D9): read current `openSprints()`; persist `active_sprint_id`; on change, one-off full rescan of the new sprint **without** the `updated` clause (still applying `scope_jql`); no active sprint → idle no-op (FR-030, FR-032). **Verify**: covered by T065 (board-scope suite).
- [X] T060 [US4] Implement the watchdog in `libs/ingest/src/watchdog.service.ts` (FR-015): runs `running` past `timeout_minutes + grace` → finalize `timed_out`/`failed` with diagnostics + failure-outcome Jira treatment (via `onRunFinished` path). **Verify**: covered by T068 (watchdog-drift suite).
- [X] T061 [US4] Implement drift repair in `libs/ingest/src/drift-repair.service.ts` per research D8 (pins FR-016 "per policy"): terminal runs (`succeeded`/`failed`) lacking a `run_events(type='jira_action')` marker → re-apply the pending transition/comment (idempotent per FR-023); a run whose queue job/process vanished is FAILED with diagnostics + failure treatment, **never re-driven**; never creates a duplicate active run. **Verify**: covered by T068.
- [X] T062 [US7] Implement the dependency re-evaluation step in `libs/ingest/src/reconcile.service.ts` (FR-036): for tickets currently in some agent's `trigger_status` with no active/succeeded run for that agent, fetch current issue links, re-check the gate, and trigger via `RunTriggerService` when clear — independent of the HWM floor. **Verify**: covered by T066.
- [X] T063 [US2] Implement `ReconcileService.run()` orchestrating the four ordered steps (poll&diff → dependency re-eval → watchdog → drift repair), each wrapped in its own try/catch (one failing step logs and continues), sharing one pass-level Jira budget; delegate from `apps/worker/src/reconcile.processor.ts` (replaces the no-op). **Verify**: `pnpm nest build worker` exits 0; integration test — a step forced to throw does not prevent the others from running (assert the later step's effect still occurs).
- [X] T064 [US2] Integration test `test/integration/reconcile-catchup.spec.ts` (uses mock-Jira): simulate a one-hour outage with N missed status changes, run one pass → exactly N runs triggered; run an immediate second pass → 0 additional (SC-002). **Verify**: `pnpm test:integration test/integration/reconcile-catchup.spec.ts` green (FR-011–FR-014, FR-017).
- [X] T065 [US6] Integration test `test/integration/board-scope.spec.ts` (uses mock-Jira): scrum board with no active sprint → no triggers; ticket added to the active sprint while already in a trigger status → fires exactly once (dedup holds on repeat); sprint switch → full rescan picks up in-status issues whose `updated` never changed; kanban board → unchanged behavior (SC-009). **Verify**: `pnpm test:integration test/integration/board-scope.spec.ts` green (FR-029–FR-032).
- [X] T066 [US7] Integration test (reconcile side) extend `test/integration/dependency-gate.spec.ts`: a previously-blocked ticket still in the trigger status whose blocker moves to a done category → next reconcile pass fires the agent exactly once; a subsequent pass fires zero (SC-010, even though the blocked ticket's `updated` never changed). **Verify**: `pnpm test:integration test/integration/dependency-gate.spec.ts` green including the reconcile case (FR-036).
- [X] T067 [US6] Integration test `test/integration/scope-jql.spec.ts` (uses mock-Jira): with `scope_jql = "labels = ai-pipeline"`, a ticket lacking the label never triggers even while in a trigger status; an otherwise-identical labeled ticket does (SC-011 filter half). **Verify**: `pnpm test:integration test/integration/scope-jql.spec.ts` green (FR-038).
- [X] T068 [US4] Integration test `test/integration/watchdog-drift.spec.ts` (uses mock-Jira): a run `running` past `timeout+grace` → `timed_out`/`failed` + failure-outcome treatment (SC-006); a run whose result is persisted but whose Jira write was interrupted (no `jira_action` marker) → the transition/comment are re-applied, ticket and DB agree, no duplicate active run (SC-007). **Verify**: `pnpm test:integration test/integration/watchdog-drift.spec.ts` green (FR-015, FR-016).

**Checkpoint P5**: reconcile runs all four steps idempotently; catch-up loses/dupes nothing; board scope + scope_jql + dependency re-eval + watchdog + drift repair proven; **F3 closed**.

---

## Phase 6: Checkpoint + Live Smoke (DoD Gate)

**Goal**: the whole suite is green and stable, then the manual live smoke proves the real Jira API behaves as the mock assumes, recorded in the progress journal.

- [X] T069 **[Full-suite checkpoint]** Run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration`; then run `pnpm test:integration` **3 consecutive times** to guard against flake regressions (the iteration-1 shared-container class of bug). **Verify**: static + unit green; three back-to-back integration runs all green with no stuck-at-queued/running stalls; record the run counts.
- [ ] T070 [US5] **[Live smoke — manual DoD gate]** Prerequisites: a **real test Jira project**, a dedicated **bot account (or personal) API token**, and an `agents.yaml` pointing at that project's real **board id** with `trigger_status`/`status_running?`/`status_success`/`status_failure` matching real board statuses. Boot backend (introspects board type) + worker; move one ticket into the trigger status; observe the reconcile poll trigger a **mock-executor** run → ticket transitions to `status_success` → a rendered ADF checklist comment appears in Jira. **Verify**: the transition and checklist comment are visible in the live Jira ticket; capture the ticket key + comment for the journal.
- [ ] T071 **[DoD record]** Add the iteration-2 entry to `docs/progress.md`: status/date, DoD checklist (all integration suites green on mock Jira; 1-hour catch-up proves no lost events; per-issue serialization proven under concurrency; live smoke executed), the live-smoke ticket reference, and an explicit note that **deviations F2 and F3 are CLOSED**; list this iteration's flagged elaborations (4-step reconcile vs §4's 3 duties; `jira_action` pending-write marker; `repo` kept optional beside `repositories[]`). **Verify**: `docs/progress.md` committed with the iteration-2 entry, F2/F3 marked closed, and the three elaborations noted.

**Checkpoint P6**: full suite green ×3; live smoke passed on real Jira; progress journal records DoD + F2/F3 closed.

---

## Dependencies & Execution Order

### Phase order (strict, per plan Implementation Phasing)

- **Phase 1 (Contracts+Config+Migration)** → depends on iteration-1 foundation; migration 0001 + config schema **block** the seeder (T040) and board introspection (T049).
- **Phase 2 (JiraModule client core)** → depends on P1 (workspace columns/settings for the DI factory). Builds the mock-Jira helper (T042) that **blocks every later Jira-facing test**. **Blocks P3.**
- **Phase 3 (Transition discovery + ADF)** → depends on the client (T046/T047). **Blocks onRunFinished (T055) in P4.**
- **Phase 4 (PipelineModule)** → depends on transition discovery (P3) + `RunTriggerService` (iteration 1). **Blocks the reconcile steps that emit triggers (T058/T062) in P5.**
- **Phase 5 (Reconcile job)** → depends on P4 (`onStatusChanged`/`onRunFinished`) + the client (P2/P3).
- **Phase 6 (Checkpoint + Live smoke)** → depends on all of P1–P5 green.

### Explicit blocking edges called out by the user

- **mock-Jira helper (T042)** blocks T048, T052, T056, T057, T064, T065, T066, T067, T068 (every Jira-facing test).
- **migration 0001 (T037) + config schema (T035)** block the seeder (T040) and board introspection (T049).
- **JiraModule client (T046/T047)** blocks transition discovery (T050), which blocks `onRunFinished` (T055).
- **PipelineModule (T054/T055)** blocks the reconcile steps that emit triggers (T058 poll→onStatusChanged, T062 dependency re-eval).

### Parallelizable vs sequential

- **Parallel within P1**: T034, T035, T036 (distinct files); T039 alongside T037 after schema exists. Sequential: T037→T038 (review the generated SQL); T035→T040→T041 (schema→seed→boot test).
- **Parallel within P2**: T043, T044, T045 (distinct files) after T034. Sequential: (T044+T045)→T046→T047; T042 can be built in parallel with T043–T045 but must land before T048.
- **Parallel within P3**: T051 (ADF, pure) runs parallel to T050 (transitions). Sequential: T050→T052.
- **Parallel within P4**: T053 (gate, pure) parallel to T054 scaffolding. Sequential: T053→T054; T050→T055→T056.
- **Within P5**: T058/T059/T060/T061/T062 touch distinct service files and can be drafted in parallel, but all land in `reconcile.service.ts` orchestration (T063) before the suites (T064–T068). Test suites T064–T068 are mutually parallel once T063 + mock-Jira exist.
- **Sequential in P6**: T069→T070→T071.

---

## Parallel Execution Examples

```bash
# Phase 1 contracts + deps (after nothing — start of iteration):
Task T034: add p-queue + msw deps
Task T035: extend WorkspaceConfigSchema (board_id/scope_jql/branch_prefix/repositories)
Task T036: add WorkspaceSettings + ADF + Jira value types

# Phase 2 client internals (after T034):
Task T043: JiraClient interface + errors
Task T044: rate limiter (token bucket + concurrency cap)
Task T045: per-issue write queue (p-queue map)

# Phase 5 reconcile step services (after P4 + T042):
Task T058: poller (scope JQL + HWM + diff)
Task T060: watchdog (timeout+grace)
Task T061: drift repair (pending jira_action)
```

---

## Implementation Strategy

### MVP scope

**US1 (board-driven orchestration loop) is the MVP** — reached at the **end of Phase 4**, where a status change drives a run to a Jira transition + ADF comment (F2 closed). It requires Phases 1→2→3→4. The guaranteed-ingest guarantee (US2) and self-healing (US4) land in Phase 5 (F3 closed); the live smoke (US5) is the Phase 6 gate.

### Incremental delivery

1. Phase 1 → config accepts the documented shape; board migration in place (US6 config half).
2. Phase 2 → rate-limit-safe client + mock Jira (US3 substrate; US6 introspection).
3. Phase 3 → correct transitions + ADF (US3).
4. Phase 4 → full loop on mock Jira (US1 / MVP; US7 trigger-side; **F2 closed**).
5. Phase 5 → guaranteed ingest, board scope, scope_jql, dependency re-eval, watchdog, drift repair (US2/US4/US6/US7; **F3 closed**).
6. Phase 6 → checkpoint + live smoke + DoD record (US5).

### Independent test criteria (per story)

- **US1**: status change → transition + ADF comment for all three outcomes (T056).
- **US2**: 1-hour outage → exactly N triggers, repeat → 0 (T064).
- **US3**: per-issue serialization + 429/Retry-After + 409-retry + NoTransitionPath (T048, T052).
- **US4**: timeout→fail + interrupted-write repaired, no duplicate run (T068).
- **US5**: live ticket transitions + comment on real Jira (T070).
- **US6**: scrum idle / scope-entry once / sprint-switch rescan / kanban unchanged + scope_jql (T065, T067); config forward-compat (T041).
- **US7**: blocked → no run; blocker→Done → fires exactly once (T057, T066).

### Notes

- Tests are **mandatory** for every pipeline-logic task (Constitution VI); they ship in the same phase, not batched — enforced by the per-phase integration `.spec.ts` tasks (T041, T048, T052, T056, T057, T064–T068).
- Deviations F2/F3 are **closed** this iteration (T056/T071 and T063/T071); the elaborations flagged in plan.md Complexity Tracking (4-step reconcile, `jira_action` marker, `repo` kept optional) are recorded at T071 — not "fixed" away.
- Live smoke (T070) is manual and gated on real Jira credentials; keep it as its own task so the automated suite (T069) can be the machine-verifiable DoD half.
