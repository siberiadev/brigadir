---
description: "Task list for Readable Run Timeline (026)"
---

# Tasks: Readable Run Timeline

**Input**: Design documents from `specs/026-run-timeline-readability/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: MANDATORY here. The stream parser and callback validation are pipeline logic (constitution VI); the spec also explicitly requires stream-parser unit, callback integration, and presenter/TimelineEvent unit tests (FR-021/022/023). Write each test task first; it fails until its paired implementation task lands.

**Organization**: By user story (spec.md US1–US4). The backend data-fidelity that faithful rendering depends on is Foundational (Phase 2); each user story is a frontend rendering slice, independently testable via presenter + TimelineEvent unit tests.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 for story-phase tasks only
- Exact file paths are included in each task

## Path notes

Monorepo: `libs/executors/`, `packages/contracts/`, `apps/web/`, `test/integration/`. `presenter.ts` and `TimelineEvent.vue` are shared by US1–US4 — story phases serialize their edits (not cross-story `[P]`), but each story remains independently testable.

> **Implementation note (2026-07-21):** the extracted timeline-entry component is `components/RunTimeline/TimelineEvent.vue` (test `run-timeline-event.spec.ts`), **not** `RunCard.vue` — that name is already taken by the unrelated run **detail view** `apps/web/src/views/RunCard.vue`. Tasks below were renamed accordingly. T012's integration assertions are written but require Docker/testcontainers, so they were not executed in the authoring environment; the equivalent contract-level acceptance (4000-char message) is covered by the unit suite.

---

## Phase 1: Setup

**Purpose**: Confirm prerequisites; no new dependencies expected.

- [X] T001 [P] Confirm `lucide-vue-next` (installed version) exports `Megaphone`, `MessageCircleQuestion`, `FlagTriangleRight` (grep `node_modules/lucide-vue-next` or a scratch import); if any name moved, record the substitute glyph in `specs/026-run-timeline-readability/research.md` R8. No new dependency is added by this feature.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Faithful data at the write path + the shared frontend seam. Blocks all user stories.

**⚠️ CRITICAL**: No user-story rendering work should begin until this phase is complete. This phase is itself a verifiable increment (quickstart §1–§3 pass with no frontend change).

- [X] T002 [P] Create `libs/executors/src/claude-cli/tool-input-sanitizer.ts` — pure `sanitizeToolInput(name, rawInput, scrub)` returning `{ input, truncated }` per `contracts/tool-call-payload.md`: `HUMAN_TEXT_FIELDS={message,title,details,summary}` never truncated (scrubbed); `FILE_CONTENT_FIELDS={content,new_string,old_string}` → `"<file content, N KB>"` placeholder; other strings scrubbed then capped at `MAX_FIELD_CHARS=2000` with `truncated=true` on cut. **Recurse into nested objects/arrays**, applying the same by-key policy so every nested string is scrubbed (Constitution V — closes finding C1); non-string leaf values pass through; depth/cycle-guarded; total/never-throws.
- [X] T003 [P] Create `libs/executors/src/claude-cli/tool-input-sanitizer.spec.ts` — unit tests: human-text kept in full, file placeholder (size), generic cap + `truncated` flag, placeholder does NOT set `truncated`, non-string leaf passthrough, **nested strings scrubbed + capped (e.g. a `complete_task` report's `checks[].reason` and `artifacts.*` — the C1 regression guard)**, `scrub` invoked once per retained string (spy, incl. nested) and NOT for placeholdered content, empty `{}` / array / non-object input, cycle-safe, never throws.
- [X] T004 Wire the sanitizer into `libs/executors/src/claude-cli/stream-parser.ts` `mapAssistant`: emit `{ name, input: sanitized.input, truncated: sanitized.truncated }` instead of `truncate(JSON.stringify(input))`; add an injectable `scrub` to `StreamParserOptions` (default identity). (depends on T002)
- [X] T005 Inject the real `@brigadir/scrubber` `scrub` into the parser at its construction/parse site in `libs/executors/src/claude-cli/claude-cli.executor.ts` (Constitution V — the newly-persisted structured strings pass the scrubber). (depends on T004)
- [X] T006 Extend `libs/executors/src/claude-cli/stream-parser.spec.ts` for the structured `tool_call` payload: object `input`, `truncated` flag, file placeholder, human-text fidelity via the sanitizer. (depends on T004)
- [X] T007 [P] Extend the presenter view-model in `apps/web/src/components/RunTimeline/presenter.ts`: add the new `TimelineItem` fields (`orchestrator`, `iconKey`, `tags`, `bodyFormat`, `kv`, `legacyTruncated`, `fieldTruncated`) with safe defaults, and make `parseToolInput` accept the new object `input` + `payload.truncated` while keeping the legacy string branch. Existing presenter tests MUST stay green.
- [X] T008 Extract `apps/web/src/components/RunTimeline/TimelineEvent.vue` from `RunTimeline.vue` (behavior-preserving: `time · icon · title` row + `<pre>` body), render `<TimelineEvent>` in the list, move the icon map into it. No visual change yet. (depends on T007)
- [X] T009 [P] Create `apps/web/test/run-timeline-event.spec.ts` — component scaffold (@vue/test-utils) rendering a basic item (row/title/body present), extended per story below. (depends on T008)

**Checkpoint**: Backend emits structured, faithful `tool_call` payloads (tested); the frontend renders identically to before through the new `TimelineEvent` seam.

---

## Phase 3: User Story 1 - Read the full agent narrative (Priority: P1) 🎯 MVP

**Goal**: Every human/assistant-authored text shown in full and formatted (Markdown); file bodies elided to a size placeholder; very long bodies collapsed per entry.

**Independent Test**: A run with a >500-char progress message, Markdown human-request details, a completion summary, and a large file write renders each text complete + formatted, the file as `<file content, N KB>`, and a long body collapsed with a per-entry expand control.

### Tests for User Story 1 ⚠️ (write first; fail until paired impl lands)

- [X] T010 [P] [US1] Extend `libs/executors/src/claude-cli/stream-parser.spec.ts`: assistant text persisted **untruncated** as a `progress` event; sampling cap raised (the ~101st text block dropped, ≤~100 kept). (impl: T015)
- [X] T011 [P] [US1] Update `packages/contracts/src/callback-tools.schema.spec.ts`: `ReportProgressSchema` accepts a 4000-char `message`, rejects 4001. (impl: T016)
- [X] T012 [P] [US1] Extend `test/integration/callback-progress.spec.ts`: `POST …/progress` with a ~4000-char `message` → 200 and the persisted `progress` run_event holds the message **in full** (scrubbed); and a `POST …/human` with multi-paragraph `details` persists the `human_tasks.details` in full (human-authored fidelity, FR-022). (impl: T016)
- [X] T013 [P] [US1] Presenter tests in `apps/web/test/run-timeline-presenter.spec.ts`: message-like bodies → `bodyFormat:'markdown'`; `command`/raw → `'mono'`; a `Write` with `content` placeholder renders as body. (impl: T017)
- [X] T014 [P] [US1] TimelineEvent tests in `apps/web/test/run-timeline-event.spec.ts`: `markdown` renders via `MarkdownText`, `mono` via `<pre>`; a body over the threshold shows "show more" and toggling reveals full text; a short body shows no control. (impl: T018, T019)

### Implementation for User Story 1

- [X] T015 [US1] In `libs/executors/src/claude-cli/stream-parser.ts` `sampleProgress`: persist the **full** `text` (remove `truncate`); raise default `maxProgressEvents` 20 → 100; keep the count/interval sampling; drop the now-unused `snippetMaxChars` progress role. (depends on T004)
- [X] T016 [P] [US1] In `packages/contracts/src/callback-tools.schema.ts` change `ReportProgressSchema.message` `.max(500)` → `.max(4000)` per `contracts/callback-cap-change.md`.
- [X] T017 [US1] In `apps/web/src/components/RunTimeline/presenter.ts` select `bodyFormat`: progress `message` / request `details` / complete `summary` → `'markdown'`; `command` / legacy raw / non-text raw → `'mono'`; nothing → `null`. (depends on T007)
- [X] T018 [US1] In `apps/web/src/components/RunTimeline/TimelineEvent.vue` render `bodyFormat:'markdown'` via `MarkdownText.vue` and `'mono'` via the existing `<pre>` block; the file-content placeholder is a plain string and renders inline. (depends on T008, T017)
- [X] T019 [US1] In `apps/web/src/components/RunTimeline/TimelineEvent.vue` add per-entry expand/collapse for long bodies (threshold ~8–12 lines / ~800 chars via CSS `max-height` clamp + "show more/less"), one control per entry, full text always in the DOM; static, honor `prefers-reduced-motion`. (depends on T008)

**Checkpoint**: MVP — the timeline shows full, formatted narratives, elided file bodies, and collapsible long messages.

---

## Phase 4: User Story 2 - Distinguish orchestrator calls (Priority: P1)

**Goal**: Brigadir callbacks carry distinct static icons and `→ Brigadir` / `Complete · …` titles, visually separable from ordinary tools.

**Independent Test**: A run that reports progress, requests a human, and completes shows megaphone/question/flag icons and orchestrator-directed titles; a `Bash`/`Edit` call keeps the wrench icon and plain name.

### Tests for User Story 2 ⚠️ (write first)

- [X] T020 [P] [US2] Presenter tests in `apps/web/test/run-timeline-presenter.spec.ts`: `mcp__brigadir__report_progress|request_human|complete_task` → `orchestrator===true`, correct `iconKey`, titles `report_progress → Brigadir` / `request_human → Brigadir` / `Complete · <outcome>`; a non-brigadir MCP tool keeps the `(server)` form. (impl: T022)
- [X] T021 [P] [US2] TimelineEvent tests in `apps/web/test/run-timeline-event.spec.ts`: each `iconKey` maps to its lucide glyph; icons are static (no `.anim-trigger`, no `AnimatedIcon`). (impl: T023)

### Implementation for User Story 2

- [X] T022 [US2] In `apps/web/src/components/RunTimeline/presenter.ts` add `orchestrator` detection (`^mcp__brigadir__(report_progress|request_human|complete_task)$`), set `iconKey`, and set titles per `contracts/timeline-view-model.md` §3.1; keep `prettifyToolName`'s `(server)` form for other MCP tools. (depends on T007; shares `presenter.ts` with T017 — sequence after US1)
- [X] T023 [US2] In `TimelineEvent.vue` (icon map) / `RunTimeline.vue` add `Megaphone` (report_progress), `MessageCircleQuestion` (request_human), `FlagTriangleRight` (complete_task) from `lucide-vue-next`, keyed by `iconKey`, all static per project convention. (depends on T008, T022)

**Checkpoint**: Orchestrator calls are distinguishable at a glance; ordinary tools unchanged.

---

## Phase 5: User Story 3 - Typed cards for orchestrator callbacks (Priority: P2)

**Goal**: request_human and complete_task render as typed cards with tags and Markdown bodies; report_progress stays deduped.

**Independent Test**: A run with a human request (kind/title/details/blocking) and a completion (outcome/summary/checks) shows each as its typed card with expected tags and formatted body; the progress report appears once.

### Tests for User Story 3 ⚠️ (write first)

- [X] T024 [P] [US3] Presenter tests in `apps/web/test/run-timeline-presenter.spec.ts`: request_human → title=input.title, tags include `kind` + blocking state, body=details `markdown`; complete_task → title `Complete · success`, body=summary `markdown`, `<n> checks` tag; report_progress dedup preserved for both structured and legacy inputs. (impl: T026, T027)
- [X] T025 [P] [US3] TimelineEvent tests in `apps/web/test/run-timeline-event.spec.ts`: `tags[]` render as chips with tone (info/warning). (impl: T028)

### Implementation for User Story 3

- [X] T026 [US3] In `apps/web/src/components/RunTimeline/presenter.ts` build the typed cards: request_human (title, `tags` = kind + `blocking`/`non-blocking`, `body`=details, `bodyFormat:'markdown'`); complete_task (title `Complete · <outcome>`, `body`=summary `markdown`, `tags`=`<n> checks` from `checks.length`). (depends on T022; shares `presenter.ts` — sequence after US2)
- [X] T027 [US3] In `presentEvents` (`presenter.ts`) keep the `report_progress` tool_call/progress dedup reading the structured `input.message` and the legacy string form (FR-015). (depends on T026)
- [X] T028 [US3] In `apps/web/src/components/RunTimeline/TimelineEvent.vue` render `tags[]` as chips with tone. (depends on T008, T026)

**Checkpoint**: The three orchestrator callbacks render as purpose-built cards; dedup intact.

---

## Phase 6: User Story 4 - Graceful unknown & legacy payloads (Priority: P3)

**Goal**: Structured payloads with no primary text render as a key-value list; legacy truncated inputs show as-is with a note; no JSON dumps, no broken-JSON repair.

**Independent Test**: A structured payload with no message field renders as a muted key/value list; a legacy cut string renders monospace with a "truncated by the executor" note.

### Tests for User Story 4 ⚠️ (write first)

- [X] T029 [P] [US4] Presenter tests in `apps/web/test/run-timeline-presenter.spec.ts`: structured input with no primary text → `bodyFormat:'kv'`, `kv` populated (no `JSON.stringify` dump); legacy string `input` len≥500 → `mono` + `legacyTruncated`; `fieldTruncated` mirrors `payload.truncated`; no JSON.parse-repair. (impl: T031)
- [X] T030 [P] [US4] TimelineEvent tests in `apps/web/test/run-timeline-event.spec.ts`: kv list renders (muted key, regular value); truncation note shown when `legacyTruncated`/`fieldTruncated`. (impl: T032)

### Implementation for User Story 4

- [X] T031 [US4] In `apps/web/src/components/RunTimeline/presenter.ts` add the kv fallback (`bodyFormat:'kv'`, `kv[]`) for structured input lacking a primary text field, set `legacyTruncated` (legacy string, len≥500) and `fieldTruncated` (from `payload.truncated`), and never attempt to repair a cut JSON string. (depends on T026; shares `presenter.ts` — sequence after US3)
- [X] T032 [US4] In `apps/web/src/components/RunTimeline/TimelineEvent.vue` render the kv list (muted key / regular value) and a small muted "input truncated by the executor" note when `legacyTruncated` or `fieldTruncated`. (depends on T008, T031)

**Checkpoint**: All payload shapes degrade gracefully; zero raw JSON dumps.

---

## Phase 7: Polish & Cross-Cutting

- [X] T033 [P] Add the iteration entry to `docs/progress.md` (payload-shape change, no DB migration, Constitution V scrub note, tunable constants).
- [X] T034 [P] Grep `packages/mcp-server` for a hard-coded 500 `message` bound in tool definitions/tests; update to 4000 if present.
- [X] T035 Run `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm test:integration -- callback-progress`; fix any fallout. Confirm the negative constraints hold: no new `drizzle/` migration (FR-019), no change under the Jira write path (FR-020), and `presentEvents` still emits one item per non-deduped event (FR-018 — no event type filtered out). (depends on all prior)
- [X] T036 Execute `specs/026-run-timeline-readability/quickstart.md` (unit/integration + optional visual smoke); confirm SC-001…SC-007 observable. (depends on T035)

---

## Dependencies & Execution Order

### Phase order

- **Setup (P1)** → **Foundational (P2)** → **US1 (P3)** → **US2 (P4)** → **US3 (P5)** → **US4 (P6)** → **Polish (P7)**.
- Foundational BLOCKS all user stories. Polish depends on the stories being delivered.

### Story dependencies

- Each of US1–US4 depends only on **Foundational** (the structured payload + the `presenter`/`TimelineEvent` seam), not on each other, and each is independently testable via its own presenter/TimelineEvent tests.
- **File-sharing constraint**: `presenter.ts` (T007, T017, T022, T026, T031) and `TimelineEvent.vue` (T008, T018/T019, T023, T028, T032) are edited by every story. Those edits serialize (recommended order US1→US2→US3→US4). US2 does not require US1's Markdown work — a second developer could take US2 right after Foundational, coordinating merges on the two shared files.

### Within a story

- Tests written first (fail), then implementation makes them pass. Backend/contract change before its integration test goes green; presenter change before the TimelineEvent change (TimelineEvent consumes the view-model).

### Parallel opportunities

- **Setup**: T001.
- **Foundational**: T002+T003 (sanitizer + spec) run parallel to T007 (presenter type) — different packages. T004→T005→T006 serialize on the parser; T008→T009 serialize on TimelineEvent.
- **US1**: test tasks T010–T014 are all `[P]` (distinct files); T016 (contracts) is `[P]` vs the frontend impl; T015/T017/T018/T019 are the impl spine.
- **US2/US3/US4**: the two test tasks per story are `[P]`; impl tasks serialize on the shared files.

---

## Parallel Example: Foundational

```bash
# Backend sanitizer and its unit spec, alongside the presenter type extension — different packages:
Task: T002 Create libs/executors/src/claude-cli/tool-input-sanitizer.ts
Task: T003 Create libs/executors/src/claude-cli/tool-input-sanitizer.spec.ts
Task: T007 Extend TimelineItem type + parseToolInput in apps/web/.../presenter.ts
```

## Parallel Example: User Story 1 tests

```bash
Task: T010 stream-parser.spec.ts (untruncated text + sampling cap)
Task: T012 callback-progress.spec.ts (4000-char message)
Task: T013 run-timeline-presenter.spec.ts (markdown vs mono, placeholder)
Task: T014 run-timeline-event.spec.ts (MarkdownText vs <pre>, collapse toggle)
```

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (backend fidelity + seam; quickstart §1–§3 green) → 3. Phase 3 US1 → **STOP & VALIDATE**: full, formatted, collapsible narratives with elided file bodies. Demoable.

### Incremental delivery

Foundation → US1 (MVP) → US2 (orchestrator affordance) → US3 (typed cards) → US4 (graceful fallback) → Polish. Each story adds value without breaking the previous; commit after each task or logical group.

### Notes

- `[P]` = different files, no incomplete dependency.
- Verify each test fails before its implementation task.
- Keep the "everything visible" decision: only long *bodies* collapse (full text always in DOM); no entry is hidden and nothing is truncated on the read path.
- No DB migration; `run_events.payload` shape only. No change to Jira writes.
