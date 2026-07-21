# Tasks: Callback-Channel Resilience Ops — Stable Agent-Serving Runtime + Channel-Health Observability

**Input**: Design documents from `/specs/027-callback-channel-resilience/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: MANDATORY — every story here touches pipeline logic (worker consumption, callback evidence, reconciler) except pure UI subtasks; test tasks are included per story (constitution VI, spec Constraints).

**Organization**: by user story. Story→phase mapping to the spec's mergeable phases: US2+US1 = merge-phase A, US3 = B, US4 = C (B merges before C).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 (stable mode), US2 (worker exclusivity), US3 (breadcrumbs), US4 (health surface)

## Path Conventions

pnpm monorepo per plan.md: `apps/backend`, `apps/worker`, `apps/web`, `libs/*`, `packages/*`, integration tests in `test/integration/`, web tests in `apps/web/test/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: shared scaffolding both merge-phases touch; trivial, conflict-prone files done once

- [X] T001 Add `.agents-mode/` to root `.gitignore` (pidfiles/log dir of the mode script)
- [X] T002 [P] Document all five new env vars with defaults and comments in `.env.example`: `BRIGADIR_AGENTS_PORT=3210`, `BRIGADIR_WORKER_MODE`, `BRIGADIR_WORKER_LOCK_TTL_MS=15000`, `BRIGADIR_CHANNEL_HEALTH_WINDOW_MS=900000`, `BRIGADIR_CHANNEL_HEALTH_FAILURE_THRESHOLD=3` (see data-model.md §7)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared contract module consumed by US3 (reader validation) and US4 (API response)

**⚠️ CRITICAL**: blocks US3 and US4; US1/US2 do not depend on it

- [X] T003 Create `packages/contracts/src/channel.schema.ts` with `ChannelBreadcrumbRecordSchema`, `ChannelFailureEventPayloadSchema`, `ChannelHealthResponseSchema` (+ inferred types) exactly per data-model.md §1/§2/§4 and contracts/channel-health-api.md; export from `packages/contracts/src/index.ts` barrel; unit spec `packages/contracts/src/channel.schema.spec.ts` (valid/invalid records, strict response, unknown-key tolerance on breadcrumb records)

**Checkpoint**: contracts build green (`pnpm --filter @brigadir/contracts build && pnpm typecheck`)

---

## Phase 3: User Story 2 — The double-worker mistake cannot happen silently (Priority: P1)

**Goal**: Redis-held exclusive worker lock over the single queue namespace; contender refuses to consume and both sides scream (contracts/worker-lock.md). Ordered before US1 because the mode script is only safe to hand to the operator once the lock exists (both are P1, merge-phase A).

**Independent Test**: two workers on one Redis/prefix — second consumes nothing and error-logs the holder within ~2 s; holder logs the contender; release/kill → bounded takeover (quickstart §A.3–4).

### Tests for User Story 2 (pipeline logic — MANDATORY) ⚠️

> Write first; must fail before implementation

- [X] T004 [P] [US2] Integration test `test/integration/worker-lock.spec.ts` (testcontainers, unique `BULLMQ_PREFIX`, no `flushdb`): (a) worker B with same prefix picks up zero jobs while A holds the lock, error log emitted on B naming A's identity, `:contender` key visible to A; (b) graceful shutdown of A → B acquires ≤ 2 s and processes a queued mock run; (c) simulated holder death (drop renewal without release) → B acquires after TTL; (d) different prefixes → both workers run independently (suite-isolation regression guard)

### Implementation for User Story 2

- [X] T005 [US2] Implement `apps/worker/src/worker-lock.service.ts`: identity `{mode: BRIGADIR_WORKER_MODE ?? 'dev', pid, hostname, acquired_at}`; key `${BULLMQ_PREFIX ?? 'bull'}:worker-lock` (prefix + TTL read lazily at start, никаких composition-time reads); `SET NX PX` acquire loop (~2 s cadence, error-level log while blocked, sets `:contender` key TTL 30 s); renewal at TTL/3 via Lua compare-and-extend; holder-side contender detection log; compare-and-del release; `onLost` callback on renewal failure. Unit spec `apps/worker/src/worker-lock.service.spec.ts` for pure parts (key naming, identity shape, TTL math, backoff cadence) with an injected minimal redis interface
- [X] T006 [US2] Implement `apps/worker/src/worker-lock.bootstrap.ts` (`OnApplicationBootstrap`/`OnApplicationShutdown`): pause every registered WorkerHost queue consumer (run.* + reconcile queues) BEFORE lock acquisition, resume on acquire, re-pause immediately on `onLost`; release after BullMQ drain on shutdown; register both providers in `apps/worker/src/app.module.ts` (no resource init in `@Module()` args — everything inside the bootstrap lifecycle)
- [X] T007 [US2] Make T004 green; verify `maxStalledCount: 0` processors were never resumed pre-lock (assert zero `markRunning` calls for jobs enqueued while blocked)

**Checkpoint**: SC-002 demonstrable; a lone dev worker still starts instantly (lock acquired on first try) — Phase-0 behavior unchanged

---

## Phase 4: User Story 1 — Agent runs survive human dev activity (Priority: P1)

**Goal**: one-command stable serving mode: second native non-watch pair on `BRIGADIR_AGENTS_PORT` (research.md R1), documented in local-setup.

**Independent Test**: quickstart §A.1–2 — enter mode, run a callback-wired run, kill/restart the dev stack mid-run, run finalizes with zero channel evidence.

### Implementation for User Story 1

- [X] T008 [US1] Create `scripts/agents-mode.mjs` (plain Node ≥22, no deps): `start` = build chain (`pnpm --filter @brigadir/contracts build && pnpm build:mcp-server && nest build backend && nest build worker`) then spawn detached `node --env-file=.env dist/apps/backend/main.api.js` (env `PORT=<agents-port>`) and `node --env-file=.env dist/apps/worker/main.worker.js` (env `BRIGADIR_CALLBACK_BASE_URL=http://127.0.0.1:<agents-port>/api/callbacks`, `BRIGADIR_WORKER_MODE=agents`), pidfiles + log files under `.agents-mode/`, cwd = repo root (guard/probe path resolution — FR-005); `stop` = SIGTERM via pidfiles, wait for exit (worker drain ≤ 35 s), cleanup pidfiles; `status` = pid liveness + `GET /health` + `GET /api/callbacks/health` on the agents port + hint to check worker log for lock state; refuse `start` when pidfiles point at live processes
- [X] T009 [P] [US1] Add root `package.json` scripts: `agents:start` / `agents:stop` / `agents:status` → `node scripts/agents-mode.mjs <cmd>`
- [X] T010 [P] [US1] Document the mode in `docs/local-setup.md` new §2a «Стабильный режим для агент-прогонов»: what it prevents (dev-edit outages, double consumption), enter/exit/status commands, drain-based switch procedure (lock waits, active runs finish under the old holder), FR-005 note (guard/probe работают идентично — same dist paths, same configRoot), cross-links to §2 and pitfalls §6
- [X] T011 [US1] Execute quickstart §A drills 1, 2 and 5 (mode up + SC-001 dev-churn drill + stale-artifact parity) and record outcomes in the PR description; fix anything that surfaces
  - Outcome 2026-07-21: drill 1 executed against throwaway containers — `agents:start` builds+boots, `/health` and `/api/callbacks/health` 200 on :3210, worker-lock acquired, `agents:stop` drains cleanly; double-worker drill live — contender ERROR ≤1 s naming holder, holder ERROR on next renew tick naming contender. Drill 2 (SC-001 with a live callback-wired Claude run) requires the operator's board+CLI — remains an operator step; drill 5 parity is exercised by the existing artifact-guard integration suite (identical cwd/paths in this mode, verified by the boot)

**Checkpoint**: merge-phase A complete (US1+US2) — SC-001/SC-002 hold; independently mergeable

---

## Phase 5: User Story 3 — Failed callbacks leave a visible trail on the run (Priority: P2)

**Goal**: mcp-server writes `.brigadir-channel/<runId>.jsonl` summaries on retry exhaustion; worker ingests them as `channel_failure` run-events at exit + via reconciler; timeline renders them (contracts/channel-breadcrumbs.md). Merge-phase B.

**Independent Test**: quickstart §B — run against a dying channel; run detail shows the failure timeline without SQL; breadcrumb file consumed.

### Tests for User Story 3 (pipeline logic — MANDATORY) ⚠️

> Write first; must fail before implementation

- [X] T012 [P] [US3] Unit spec `packages/mcp-server/src/channel-breadcrumbs.spec.ts`: appends valid JSONL matching `ChannelBreadcrumbRecordSchema` fixture keys; never throws on unwritable dir; skips append past 64 KB; `target` is host:port only
- [X] T013 [P] [US3] Extend `packages/mcp-server/src/tools.spec.ts`: mock-suite — network-budget exhaustion writes one record (`kind:'network'`, `attempts:11`), 5xx exhaustion writes one (`kind:'http'`, `attempts:4`, `status`), success/4xx write nothing; real-fetch contract block — refused connection over real undici ⇒ breadcrumb line present AND outbox file still present
- [X] T014 [P] [US3] Unit spec `libs/executors/src/claude-cli/channel-breadcrumbs.spec.ts`: two concurrent claims → exactly one winner (rename race); invalid JSON lines dropped, valid ones kept; consume best-effort; retention listing
- [X] T015 [P] [US3] Integration test `test/integration/channel-breadcrumbs.spec.ts`: (a) terminal exit branch ingests file → `channel_failure` rows with `source:'exit'`, `occurred_at` = record ts, file gone; (b) reconciler ingests an orphaned file for a terminal run (`source:'reconcile'`); (c) exit+reconciler race → no duplicate rows; (d) file for an active (`running`) run untouched by reconciler; (e) unknown-UUID file retained then deleted past retention; (f) run status/outcome never modified by ingestion

### Implementation for User Story 3

- [X] T016 [P] [US3] Implement `packages/mcp-server/src/channel-breadcrumbs.ts`: `appendChannelBreadcrumb(markerPath, runId, record)` — dir `<dirname(markerPath)>/.brigadir-channel`, mkdir recursive, `appendFile` one JSON line, 65536-byte cap check, full try/catch swallow (outbox writer posture, `packages/mcp-server/src/outbox.ts` as reference)
- [X] T017 [US3] Hook into `packages/mcp-server/src/tools.ts`: add optional `onExhausted(record)` to the retry config; invoke at BOTH budget-exhaustion branches of `fetchWithRetry` (network synthetic-result branch and 5xx return branch) with `{ts, tool, kind, attempts, error:{name,message}, status?, target: host:port}`; `createToolHandlers` wires it per tool name to `appendChannelBreadcrumb` using cfg markerPath/runId (depends on T016)
- [X] T018 [P] [US3] Implement reader helpers `libs/executors/src/claude-cli/channel-breadcrumbs.ts`: `channelBreadcrumbDirPath(configRoot)`, `listChannelBreadcrumbFiles`, `claimChannelBreadcrumbFile` (atomic rename → `.ingesting`, ENOENT ⇒ null), `readClaimedBreadcrumbs` (per-line parse via `ChannelBreadcrumbRecordSchema`, invalid dropped), `consumeClaimed`, retention helpers mirroring `outbox.ts`
- [X] T019 [US3] Implement `apps/worker/src/channel-breadcrumb-ingest.ts`: const `CHANNEL_FAILURE_EVENT = 'channel_failure'`; `ingest(runId, source)` — claim → parse → scrub `error.message` (existing secret scrubber) → insert `run_events` rows (payload per data-model.md §2) → consume; best-effort, never throws into finalization (depends on T018, T003)
- [X] T020 [US3] Wire exit-path ingestion in `apps/worker/src/claude-cli-run.processor.ts`: call ingest with `source:'exit'` after EVERY terminal branch of callback-wired runs (completed-mapped finalize, fail-closed, timed_out, cancelled, crash-финал); non-callback (Phase-0) runs never call it (depends on T019)
- [X] T021 [US3] Extend `apps/worker/src/outbox-reconcile.service.ts`: second scan over `.brigadir-channel/*.jsonl` — terminal-status runs → `ingest(runId, 'reconcile')`; active runs skipped; unknown/invalid names + orphaned `.ingesting` → `BRIGADIR_OUTBOX_RETENTION_MS` retention with warn-once (depends on T019)
- [X] T022 [P] [US3] Render in timeline: `apps/web/src/components/RunTimeline/presenter.ts` — add `channel_failure` to `TimelineTypeKey` + `KNOWN_TYPES`, `presentChannelFailure` (kv body: tool, attempts, kind, last error, target; time from `occurred_at`; Russian title consistent with 026 cards); `apps/web/src/components/RunTimeline/TimelineEvent.vue` — `Unplug` lucide icon (static), `--el-color-danger` accent
- [X] T023 [P] [US3] Web component tests: extend `apps/web/test/run-timeline-presenter.spec.ts` and `apps/web/test/run-timeline-event.spec.ts` for `channel_failure` (title, kv fields, icon, danger accent, occurred_at display)
- [X] T024 [US3] Make T012–T015 green end-to-end; run quickstart §B.2 live scenario and record in PR

**Checkpoint**: merge-phase B complete — SC-003 holds; run detail explains failures with zero SQL

---

## Phase 6: User Story 4 — Operator sees channel health at a glance (Priority: P3)

**Goal**: `GET /api/channel-health` aggregate + global sidebar indicator + runs-list `callback_alert` marker (contracts/channel-health-api.md). Merge-phase C — merges only after B (consumes `channel_failure`).

**Independent Test**: quickstart §C — seeded failures flip the indicator degraded within one 5 s poll, click-through lands on affected runs, window expiry auto-recovers.

### Tests for User Story 4 (pipeline logic — MANDATORY) ⚠️

> Write first; must fail before implementation

- [X] T025 [P] [US4] Integration test `test/integration/channel-health.spec.ts`: status matrix (fresh ⇒ healthy/null/zeros; 1 `channel_down` ⇒ degraded; threshold−1 `channel_failure` ⇒ healthy, threshold ⇒ degraded; stale artifact ⇒ degraded with `deployment_guard.reason:'stale'`); events older than window ignored (auto-recovery); `affected_runs` distinct+newest-first+cap 20 (+ `ticket_key` join); `last_successful_callback_at` from `via:'callback'` progress rows only (stream-parser rows without tag not counted); 401 without dashboard token; runs-list `callback_alert` projection true/false per `undelivered_report`/`channel_failure` existence

### Implementation for User Story 4

- [X] T026 [P] [US4] Tag live callbacks: add `via: 'callback'` to the progress event payload insert in `libs/callback/src/callback.service.ts` (additive; callback HTTP contract otherwise untouched)
- [X] T027 [P] [US4] Add `callback_alert: z.boolean()` to `RunListItemSchema` in `packages/contracts/src/runs.schema.ts` (strict schema — server must project it)
- [X] T028 [US4] Implement `apps/backend/src/dashboard/channel-health.service.ts`: lazy-read `BRIGADIR_CHANNEL_HEALTH_WINDOW_MS`/`_FAILURE_THRESHOLD` at request time; windowed counts over `run_events` (`channel_failure`, `channel_down`); `last_successful_callback_at` via tagged progress rows; guard verdict via `createMemoizedArtifactGuard` (existing `libs/executors/src/claude-cli/artifact-guard.ts`, TTL 10 s); `affected_runs` query (3 event types, distinct, cap 20, ticket join); degraded rule per contract (depends on T003)
- [X] T029 [US4] Implement `apps/backend/src/dashboard/channel-health.controller.ts` (`GET /api/channel-health`, `@UseGuards(DashboardTokenGuard)`, response validated by `ChannelHealthResponseSchema`); register controller+service in `apps/backend/src/dashboard/dashboard.module.ts` (depends on T028)
- [X] T030 [US4] Project `callback_alert` in the workspace runs list query in `apps/backend/src/dashboard/runs.controller.ts` (EXISTS over `run_events` type IN (`undelivered_report`,`channel_failure`)) (depends on T027)
- [X] T031 [P] [US4] Web data layer: `apps/web/src/api/channelHealth.ts` (typed GET) + `apps/web/src/composables/useChannelHealth.ts` (`refetchInterval: 5000`, `placeholderData: (prev) => prev`)
- [X] T032 [US4] Implement `apps/web/src/components/ChannelHealthIndicator.vue` (static lucide `Activity`, healthy muted / degraded `--el-color-danger` + dot badge; `el-popover`: status, last success relative, counts, guard verdict, affected-runs links to `/runs/:id`, «top 20» note at cap; palette via `--el-color-*` only) and mount in `apps/web/src/components/AppSidebar.vue` `.sidebar-bottom` (no hover animation — state indicator, not a menu item) (depends on T031)
- [X] T033 [P] [US4] Add `callback_alert` marker to `apps/web/src/views/Runs.vue` status cell (small `MailWarning` icon + `el-tooltip`, danger token)
- [X] T034 [P] [US4] Web component tests: `apps/web/test/channel-health-indicator.spec.ts` (healthy/degraded render, popover contents, run links, msw handler in `apps/web/test/handlers.ts`) + extend `apps/web/test/runs-table.spec.ts` (marker shown/hidden by `callback_alert`)
- [X] T035 [US4] Make T025 green; run quickstart §C drills 1–3 and record in PR
  - Outcome 2026-07-21: T025 green (10 tests). Live drill against throwaway containers + built SPA on :3210: healthy popover (counts 0, guard ok), seeded `channel_down` → endpoint degraded + sidebar indicator red with dot + popover lists BRG-1 linking to /runs/<id>; aged the event past the window → healthy again (UI and API). Note: the 5s polling interval pauses in a hidden headless tab (TanStack default, affects all polled queries equally) — verified via reload; real operator tabs poll normally

**Checkpoint**: merge-phase C complete — SC-004/SC-006 hold

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T036 [P] Update `docs/architecture.md`: §4 — worker lock semantics + agents mode; §5 — `channel_failure` event type and breadcrumb protocol pointer; admin/dashboard section — `GET /api/channel-health`; update the run-events type vocabulary comment in `libs/database/src/schema/run-events.ts` header (no schema change)
- [X] T037 [P] Append the 027 iteration entry to `docs/progress.md` (decisions, drills executed, follow-ups)
- [X] T038 Full gates: `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration`; confirm Phase-0 suites untouched and green; sweep quickstart §0

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: none
- **Phase 2 (Foundational, T003)**: blocks US3 (reader validation) and US4 (response schema); NOT needed by US1/US2
- **US2 (Phase 3)** → **US1 (Phase 4)**: US1's operator docs/drills presuppose the lock; both are merge-phase A
- **US3 (Phase 5)**: independent of US1/US2 (merge-phase B can land before or after A)
- **US4 (Phase 6)**: depends on US3's `channel_failure` event type (merge after B); independent of A
- **Phase 7 (Polish)**: after all desired stories

### Within-Story Order

- US2: T004 (failing test) → T005 → T006 → T007
- US1: T008 → {T009, T010 in parallel} → T011
- US3: {T012–T015 failing tests in parallel} → T016 → T017; T018 → T019 → T020 & T021; T022 → T023; → T024
- US4: T025 (failing test) → {T026, T027, T031 in parallel} → T028 → T029, T030 → T032, T033 → T034 → T035

### Parallel Opportunities

- T001 ∥ T002; T012 ∥ T013 ∥ T014 ∥ T015 (four different test files); T016 ∥ T018 (writer vs reader, different packages); T022–T023 (web) ∥ T019–T021 (worker); T026 ∥ T027 ∥ T031; T036 ∥ T037. After Phase 2, merge-phase A (US2+US1) and merge-phase B (US3) can proceed fully in parallel.

## Parallel Example: User Story 3

```bash
# Kick off all four failing test suites at once (different files):
Task: "Unit spec packages/mcp-server/src/channel-breadcrumbs.spec.ts"
Task: "Extend packages/mcp-server/src/tools.spec.ts (mock + real-fetch cases)"
Task: "Unit spec libs/executors/src/claude-cli/channel-breadcrumbs.spec.ts"
Task: "Integration test test/integration/channel-breadcrumbs.spec.ts"

# Then writer and reader sides in parallel (different packages):
Task: "Implement packages/mcp-server/src/channel-breadcrumbs.ts"
Task: "Implement libs/executors/src/claude-cli/channel-breadcrumbs.ts"
```

## Implementation Strategy

### MVP First (merge-phase A)

1. Phase 1 → Phase 3 (US2, the lock) → Phase 4 (US1, the mode script + docs)
2. **STOP and VALIDATE**: quickstart §A drills; this alone removes the incident's SPOF (SC-001, SC-002) with zero UI work
3. Merge A as its own PR

### Incremental Delivery

1. **PR-A** (US2+US1): lock + mode + docs — the outage class dies here
2. **PR-B** (US3, after Phase 2): breadcrumbs end-to-end — failures become visible per run (SC-003)
3. **PR-C** (US4): health endpoint + indicator + list marker — operator sees channel state at a glance (SC-004, SC-006)
4. Polish (T036–T038) rides the last PR

### Notes

- Verify each story's tests fail before implementing (T004, T012–T015, T025)
- Commit after each task or logical group; each merge-phase is one PR per the house iteration convention
- `run_events` stays migration-free; if window queries ever slow down, a partial index is a documented follow-up, not part of this feature
