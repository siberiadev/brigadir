# Implementation Plan: Readable Run Timeline

**Branch**: `claude/new-session-ultlns` (spec dir `026-run-timeline-readability`) | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/026-run-timeline-readability/spec.md`

## Summary

Make the run timeline fully readable: persist every agent-authored text in full and every tool input as a decomposable structured object (not a truncated JSON blob), then render orchestrator (Brigadir) callbacks as typed, Markdown-formatted cards visually distinct from ordinary tools, with a per-entry expand/collapse for very long bodies. Three seams change:

1. **Executor stream parser** (`libs/executors/src/claude-cli/stream-parser.ts`) — replace `truncate(JSON.stringify(input))` with a per-field sanitizer that emits a structured `input` object + a `truncated` flag; stop truncating human/assistant text; raise the progress-sampling cap. The parser's output flows straight into `run_events` via `claude-cli.executor.ts` `persistRunEvent`, so this is the only backend write that changes.
2. **Callback contract** (`packages/contracts/src/callback-tools.schema.ts`) — raise `report_progress.message` max 500 → 4000.
3. **Timeline presenter + component** (`apps/web/src/components/RunTimeline/`) — typed cards for the three brigadir callbacks, Markdown vs. monospace vs. key-value body selection, orchestrator icons/titles, a per-entry collapse control, and graceful legacy degradation.

No DB migration (`run_events.payload` is `jsonb`); no change to how the system writes to Jira; the `report_progress` tool_call/progress dedup is preserved.

## Technical Context

**Language/Version**: TypeScript strict (monorepo, pnpm workspaces)

**Primary Dependencies**: NestJS 11 (backend/worker), Drizzle ORM + Postgres 16, Vue 3 + Element Plus, `lucide-vue-next` (icons), Vitest (unit + integration), zod (contracts)

**Storage**: Postgres `run_events` table — `payload jsonb` (unchanged schema); this feature changes only the **shape of values** stored in `payload` for `tool_call` events

**Testing**: Vitest unit (stream-parser, presenter, RunCard component via @vue/test-utils), Vitest integration with testcontainers (callback HTTP → real Postgres/Redis)

**Target Platform**: Linux server (backend/worker) + browser (Vue dashboard)

**Project Type**: Web application (monorepo: `apps/backend`, `apps/worker`, `apps/web`, `libs/*`, `packages/*`)

**Performance Goals**: Timeline rendering stays interactive for a full run's event list; per-field caps and progress sampling (≤~100 events/run) bound payload growth so no single event dominates

**Constraints**: No `run_events` schema change (payload-shape only); no new source of truth; no Jira-write changes; TypeScript strict, no `any` at module boundaries; keep the "everything visible, no expand/collapse of *entries*" decision (2026-07-15) — the new control collapses only over-long *bodies*, never whole events, and truncates nothing

**Scale/Scope**: ~3 code seams, ~1 contract cap change; internal tool, single-digit concurrent operators reading timelines

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Dual Source of Truth** — PASS. `run_events` stays the Postgres-owned timeline; no new source of truth, no reconciliation bypass. Only the JSON value shape changes.
- **II. Idempotency at Three Levels** — PASS (N/A). No new run-triggering path; dedup layers untouched. The presenter-side `report_progress` dedup (a display concern, not a run-trigger guard) is explicitly preserved (FR-015).
- **III. System-Only Jira Writes** — PASS. No agent gains a write path; no change to the JiraModule write queue or ADF construction (FR-020).
- **IV. Run Completion Contract** — PASS. `complete_task` remains the sole completion channel; we only *render* its already-stored summary/outcome/checks on the timeline. No new completion or rescue path.
- **V. Secret Isolation & Output Scrubbing** — ATTENTION → addressed in design. This feature persists **more** agent-authored text into `run_events` (full progress/assistant text, structured tool inputs). Parser-side `tool_call` events are today written without the report scrubber. Decision (research R6): the sanitizer applies the existing `@brigadir/scrubber` `scrub()` to each retained string field at the executor persist boundary, so raising fidelity does not widen secret exposure. Human-text fields are scrubbed too (matching the callback path, which already scrubs `message`/`title`/`details`/`summary`).
- **VI. Test-Mandatory Pipeline Logic** — PASS. The stream parser (executor status/timeline mapping) and callback validation are pipeline logic; both ship tests in this iteration: stream-parser unit tests (structured input, per-field truncation + flag, file-content placeholder, no-truncation of human/assistant text, raised sampling cap, scrub applied), callback integration tests (raised message cap, full-fidelity persistence), and presenter + RunCard unit tests (typed cards, icons/titles, body-format selection, kv fallback, legacy degradation, collapse threshold).

**Technology Constraints** — PASS. No stack deviation. No `@Module()`-argument resource init added (Lazy resource resolution rule not engaged). No migration (payload jsonb).

**Result**: No violations. Complexity Tracking table below intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/026-run-timeline-readability/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (sanitizer policy, scrubbing, card typing, collapse, legacy)
├── data-model.md        # Phase 1 — persisted payload shapes + presenter view-model
├── quickstart.md        # Phase 1 — how to validate end-to-end
├── contracts/
│   ├── tool-call-payload.md     # Persisted run_events tool_call payload contract (new shape + legacy)
│   ├── callback-cap-change.md   # report_progress.message 500 → 4000
│   └── timeline-view-model.md   # Presenter TimelineItem output contract
└── checklists/
    └── requirements.md          # Spec quality checklist (from /speckit-specify)
```

### Source Code (repository root)

```text
libs/executors/src/claude-cli/
├── stream-parser.ts            # CHANGE: structured tool_call input + truncated flag; no text truncation; sampling cap 20→100
├── stream-parser.spec.ts       # EXTEND: sanitizer, placeholder, flag, non-truncation, cap
├── tool-input-sanitizer.ts     # NEW: pure per-field sanitizer (policy + placeholder + flag), scrub injected
├── tool-input-sanitizer.spec.ts# NEW: unit tests for the sanitizer in isolation
└── claude-cli.executor.ts      # CHANGE (minimal): wire real scrub() into the parser/sanitizer at persist boundary

packages/contracts/src/
├── callback-tools.schema.ts    # CHANGE: ReportProgressSchema.message max 500 → 4000
└── callback-tools.schema.spec.ts # EXTEND: assert 4000 accepted, >4000 rejected

apps/web/src/components/RunTimeline/
├── presenter.ts                # CHANGE: typed brigadir cards, body-format + kv, orchestrator flags/icons, legacy note
├── RunCard.vue                 # NEW: one timeline entry — row + tags + body (markdown|mono|kv) + collapse control
└── RunTimeline.vue             # CHANGE: render RunCard; extend icon map (Megaphone/MessageCircleQuestion/FlagTriangleRight)

apps/web/test/
├── run-timeline-presenter.spec.ts # EXTEND: cards, icons/titles, formats, kv, legacy, dedup preserved
└── run-card.spec.ts               # NEW: component — markdown vs mono vs kv, tags, collapse toggle, static icons

test/integration/
└── callback-progress.spec.ts   # EXTEND: 4000-char message persists in full; human-text fidelity
```

**Structure Decision**: Existing monorepo layout, no new packages. One new pure helper (`tool-input-sanitizer.ts`) beside the parser to keep truncation policy unit-testable in isolation, and one new presentational component (`RunCard.vue`) so the three body-format paths and the collapse control are component-unit-testable — matching the spec's "presenter/RunCard unit tests" and this repo's convention of small, testable units.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
