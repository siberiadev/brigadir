# Tasks: Suggested Answer Options on Human Tasks

**Input**: Design documents from `/specs/013-human-task-answer-options/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D8), data-model.md, contracts/answer-options.md

**Tests**: MANDATORY — callback validation, report processing, and the human-task
flow are pipeline logic (constitution VI); test tasks ship in the same
commits as their functionality.

**Organization**: grouped by user story; the Foundational phase carries the shared
schema + column both intake stories need.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

*(nothing — existing monorepo, no new tooling, no new packages)*

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the shared option shape and the storage column — every story reads
these.

- [x] T001 Create `AnswerOptionSchema` + `AnswerOptionsSchema` (zod 4, `.strict()`, `.min(1).max(5)`, `.describe(...)` per contracts/answer-options.md §1 incl. "choice, not an essay" coaching and the value-defaults-to-label note) in `packages/contracts/src/answer-option.schema.ts`; export from `packages/contracts/src/index.ts`
- [x] T002 [P] Contract tests for the shared shape in `packages/contracts/src/answer-option.schema.spec.ts`: label ≤80 / value ≤500 / description ≤200 enforced, empty strings rejected, max 5 items, empty array rejected, `.strict()` rejects unknown keys, value/description optional
- [x] T003 Add nullable `options: jsonb('options')` to `libs/database/src/schema/human-tasks.ts`; run `drizzle-kit generate` → `drizzle/0006_*.sql` + `drizzle/meta/0006_snapshot.json` + `_journal.json` (no hand edits)
- [x] T004 Write `drizzle/REVIEW-0006_*.md` reviewing the generated SQL against `docs/architecture.md` §3 AND amend §3's `human_tasks` DDL with the `options jsonb` column in the same change (CLAUDE.md rule 5, format per REVIEW-0005)

**Checkpoint**: contracts + column exist; `pnpm typecheck && pnpm test` green.

---

## Phase 3: User Story 2 — Options travel through both intake surfaces and the queue API (Priority: P2, but foundational for US1's end-to-end loop) 

**Goal**: `request_human` and `needs_human` accept, scrub, and persist options;
the queue API serves them; system-composed tasks stay NULL.

**Independent Test**: integration — create a task via each surface with options,
list globally and workspace-scoped, both items carry them scrubbed; oversized
payloads 422.

> Note: US2 is implemented before US1 because the UI story consumes the API this
> story produces. Each story still tests independently.

### Implementation for User Story 2

- [x] T005 [US2] Add `options: AnswerOptionsSchema.optional()` to `RequestHumanSchema` in `packages/contracts/src/callback-tools.schema.ts` and to `ReportHumanTaskSchema` in `packages/contracts/src/report.schema.ts`
- [x] T006 [US2] Add `options: z.array(AnswerOptionSchema).nullable()` to `HumanQueueItemSchema` in `packages/contracts/src/human-queue.schema.ts`
- [x] T007 [P] [US2] Contract tests: options accepted/bounded on `RequestHumanSchema` (`packages/contracts/src/callback-tools.schema.spec.ts`) and on `ReportHumanTaskSchema` incl. inside a full `needs_human` report (`packages/contracts/src/report.schema.spec.ts`); `HumanQueueItemSchema` requires `options` nullable field
- [x] T008 [US2] Scrub option texts at both intake points in `libs/callback/src/callback.service.ts`: `human()` maps `scrub()` over each option's label/value/description before `createFromRequest`; `scrubReport()` does the same for `human_task.options` (mirror the title/details pattern, comment Constitution V)
- [x] T009 [US2] Persist options on the tool path: `CreateHumanTaskInput` gains `options?: AnswerOption[]` (doc: caller has scrubbed) and the insert writes `options: input.options ?? null` in `libs/human-tasks/src/human-task.service.ts`; `createNonBlocking` and `maybeQueueReviewTask` (system-composed) pass none
- [x] T010 [US2] Persist options on the report path: `RunsService.createHumanTask` writes `humanTask.options ?? null` in `libs/runs/src/runs.service.ts`
- [x] T011 [US2] Serve options from the shared list select in `apps/backend/src/dashboard/human-tasks.controller.ts` (`options: schema.humanTasks.options` + map to `r.options ?? null` typed as the contract array) — one change covers the global queue and the workspace tab
- [x] T012 [P] [US2] Extend `libs/callback/src/callback.service.spec.ts`: `human()` scrubs a canary secret in an option label/value before delegating; `scrubReport` covers `human_task.options`; a 6-option payload returns a validation failure
- [x] T013 [P] [US2] Extend mock executor for drivability: optional `mock_options` (typed `AnswerOptionsSchema.optional()`) in `packages/contracts/src/trigger-event.schema.ts`; `needsHumanReport()` in `libs/executors/src/mock.executor.ts` attaches them when present; assert in `libs/executors/src/mock.executor.spec.ts`
- [x] T014 [US2] Integration test `test/integration/human-task-options.integration.spec.ts` (harness + mock executor + mock-jira): (a) `request_human` with options → row persisted with scrubbed options → `GET /api/human-tasks` and `?workspace=` both carry them; (b) mock `needs_human` run with `mock_options` → task carries options; (c) canary secret in a label is scrubbed (Constitution V); (d) system-composed task (mock PR-review or triage-limit path) has `options IS NULL`; (e) resolving with an option's `value` lands in `resolution` and the resumed run's handoff contains `Question:`/`Answer: <value>` (proves FR-009 with resume/handoff untouched)

**Checkpoint**: full backend loop drivable without live agents; existing
human-queue/resume/answer-triage suites green untouched.

---

## Phase 4: User Story 1 — Human picks an option in the drawer (Priority: P1) 🎯 MVP

**Goal**: option buttons in the Human Queue drawer pre-fill the answer; explicit
submit unchanged; custom text always available.

**Independent Test**: web (MSW) — a task with options renders buttons; click fills
the input with `value ?? label`; no auto-submit; null options ⇒ today's UI.

### Implementation for User Story 1

- [ ] T015 [US1] Render option buttons in the open-task footer of `apps/web/src/views/HumanQueue.vue`: above the answer textarea, `v-if="item.options?.length"`; per option an `el-button` (plain) with label text, `description` as secondary line/tooltip; click sets `draftFor(item.id).answer = option.value ?? option.label` (last click wins, input stays editable); NO submit on click; closed view untouched (`HumanTaskDrawer.vue` stays presentational per research D7)
- [ ] T016 [P] [US1] Small "N options" hint on `apps/web/src/components/HumanQueue/HumanTaskRow.vue` for open tasks with options (optional polish; plural via existing pluralize util if suitable)
- [ ] T017 [US1] Update MSW fixtures in `apps/web/test/handlers.ts` so human-task items include `options` (null on existing fixtures to prove no-change; one fixture with 2–3 options incl. an omitted `value` and a `description`)
- [ ] T018 [US1] Web tests in `apps/web/test/human-task-options.spec.ts`: buttons render for the options task (labels + description visible); click fills the answer input with `value` (and with `label` when value omitted); clicking a second option replaces the draft; typing custom text after a click still submits the typed text; no buttons for `options: null`; submit still requires the explicit button (no resolve call fired on option click)
- [ ] T019 [US1] Verify `apps/web/test/human-queue.spec.ts` passes UNTOUCHED (SC-002 regression guard) — if it needs edits, the implementation is wrong, not the test

**Checkpoint**: two-click answering works against MSW; options-less tasks pixel-identical.

---

## Phase 5: User Story 3 — Jira mirror + agent-facing prose (Priority: P3)

**Goal**: options visible in the Jira question comment; agents told the field exists.

**Independent Test**: ADF snapshot with/without options; wrapper text snapshot/assert.

### Implementation for User Story 3

- [ ] T020 [US3] Extend `buildHumanTaskComment` in `libs/jira/src/adf-composer.ts`: input widened with `options?: AnswerOption[]`; when present append `paragraph('Suggested answers:')` + deterministic `bulletList` (label, ` — description` when present; `value` never rendered — research D6)
- [ ] T021 [P] [US3] Extend `libs/jira/src/adf-composer.spec.ts`: snapshot WITH options (list rendered) and assert the no-options document is byte-identical to the pre-013 snapshot
- [ ] T022 [US3] Add ONE sentence to the `request_human` bullet in `callbackToolsSection()` (`libs/executors/src/claude-cli/wrapper.ts`): options `[{label, value?, description?}]` (max 5, value defaults to label) may be attached, also on `complete_task`'s `human_task` — offer them whenever the answer is a choice, not an essay; `structuredOutputSection()` byte-untouched; update/extend the wrapper spec accordingly
- [ ] T023 [P] [US3] Add one line to the workspace-setup study protocol in `libs/pipeline/src/handoff.ts` (`buildWorkspaceSetupSection`, next to the request_human advice): when asking a setup question, attach options for the likely answers ("Minimal team" / "Full team" / …); adjust `libs/pipeline/src/handoff.spec.ts` if it asserts the block text

**Checkpoint**: Jira parity + agent discovery done; ADF deterministic.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T024 [P] Documentation: `docs/architecture.md` §5 (`request_human` schema sketch + `human` semantics mention options) and §6 (`human_task.options` in the ReportSchema JSON sketch + rules line); §3 already amended in T004
- [ ] T025 [P] Documentation: iteration row in `docs/plan-internal.md` + checkpoint entry in `docs/progress.md` (feature 013 — what shipped, decisions D1–D8 pointers, gates run)
- [ ] T026 Run all gates: `pnpm typecheck && pnpm lint && pnpm test` and `pnpm test:integration`; fix fallout; confirm quickstart.md expected outcomes (SC-001…SC-005)

---

## Dependencies & Execution Order

- **Phase 2 blocks everything** (T001 → T002…T004; T003 → T004).
- **US2 (Phase 3)** after Phase 2; internal order T005/T006 → T007…T011 → T012/T013 → T014.
- **US1 (Phase 4)** after T006 + T011 (needs `options` on the queue API/type). T015 → T017 → T018/T019; T016 parallel.
- **US3 (Phase 5)** after T001 only — parallel with US1 and most of US2, except T020 lands with T009 available (the composer input is `CreateHumanTaskInput`-shaped).
- **Polish** last; T026 is the final gate.

### Parallel opportunities

- T002 ∥ T003 after T001.
- Within US2: T007 ∥ T008–T011; T012 ∥ T013.
- US3 (T020–T023) ∥ US1 (T015–T019) once Phase 3 lands.
- T024 ∥ T025.

## Implementation Strategy

Sequential single-developer flow matching commit discipline (tests with their
functionality, constitution VI): Phase 2 (one commit), US2 backend loop (one–two
commits incl. integration test), US1 web (one commit), US3 mirror+prose (one
commit), docs+gates (final commit). MVP = Phases 2–4 (options usable end to end
from the dashboard); Phase 5 adds Jira parity and agent discovery.
