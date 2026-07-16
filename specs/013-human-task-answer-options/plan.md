# Implementation Plan: Suggested Answer Options on Human Tasks

**Branch**: `claude/human-task-answer-options-1k1a51` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-human-task-answer-options/spec.md`

## Summary

Agents asking a human a question (via the `request_human` callback tool or the
`human_task` payload of a `needs_human` report) can attach up to 5 predefined
answer options. One shared `AnswerOptionSchema` in `packages/contracts` is reused
by both intake schemas and by `HumanQueueItem`; options persist in a new nullable
`human_tasks.options` jsonb column; the Human Queue drawer renders them as
one-click buttons that pre-fill the existing answer input (explicit submit stays);
the Jira question comment mirrors them as a plain ADF list. The chosen option
travels as an ordinary string through the EXISTING resolve endpoint — the
resume/answer-triage pipeline (`resume.service.ts`, `handoff.ts` Q&A rendering,
`resolve-human-task.schema.ts`) changes zero lines.

## Technical Context

**Language/Version**: TypeScript strict, Node 22, zod 4 (repo-wide since iteration 16)

**Primary Dependencies**: NestJS 11 (backend/worker), drizzle-orm 0.38 + drizzle-kit 0.30 (Postgres), BullMQ 5, Vue 3 + Element Plus + TanStack Query (web)

**Storage**: Postgres 16 — new nullable `human_tasks.options` jsonb column (migration `0006` + `REVIEW-0006` + `docs/architecture.md` §3 amended in the same change)

**Testing**: vitest (unit/contract), vitest + testcontainers (integration, real Postgres/Redis, `test/integration/harness.ts` + mock executor + `mock-jira.ts`), vitest + MSW (web, `apps/web/test/`)

**Target Platform**: Linux server (docker compose stack), self-hosted internal tool

**Project Type**: pnpm monorepo — `packages/contracts`, `libs/*` (Nest modules), `apps/backend`, `apps/web`

**Performance Goals**: n/a — a ≤5-element jsonb array on an already-listed row; no new queries, one added select column

**Constraints**: resolve endpoint contract UNCHANGED; `resume.service.ts` untouched; system-composed tasks keep `options = NULL`; no auto-submit; deterministic ADF (snapshot-stable)

**Scale/Scope**: ~9 production files touched + tests; one migration; docs §3/§5/§6

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Verdict | Notes |
|---|-----------|---------|-------|
| I | Dual Source of Truth | ✅ PASS | Options live in Postgres with the human task (run/human-task state is Postgres-owned). Jira gets a rendered mirror comment only; nothing reads state back from Jira. |
| II | Idempotency at Three Levels | ✅ PASS | No new trigger path. Task creation keeps the existing one-open-task-per-run dedup; options ride on the same insert. |
| III | System-Only Jira Writes | ✅ PASS | The options list in the question comment is composed by `buildHumanTaskComment` and posted by the system through the existing per-issue write queue. Agents still only report. |
| IV | Run Completion Contract | ✅ PASS | `ReportSchema` extension is additive and optional (`human_task.options?`); `schema_version` stays 1 — forward-compatible per Principle VI's versioning rule (old payloads validate unchanged). 409/422 semantics untouched. |
| V | Secret Isolation & Output Scrubbing | ✅ PASS | `label`/`value`/`description` pass `scrub()` in `callback.service.ts` before persistence — same guarantee as `title`/`details`, covering the downstream Jira comment (built from scrubbed input). Integration test seeds a canary secret in a label. |
| VI | Test-Mandatory Pipeline Logic | ✅ PASS | Callback validation + report processing + human-task flow are pipeline logic ⇒ contract, integration (real Postgres/Redis via testcontainers, mock executor), ADF snapshot, and web tests ship in the same commits. |
| — | Technology Constraints | ✅ PASS | No new resources, no module-decorator initialization, stack unchanged. Schema change ships as a versioned drizzle migration + review against §3 (CLAUDE.md rule 5). |

**Post-design re-check (after Phase 1)**: ✅ unchanged — the design added no
violations; Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/013-human-task-answer-options/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1–D8
├── data-model.md        # Phase 1 — option shape + column
├── quickstart.md        # Phase 1 — end-to-end validation guide
├── contracts/
│   └── answer-options.md
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/contracts/src/
├── answer-option.schema.ts        # NEW — AnswerOptionSchema + AnswerOptionsSchema (single home)
├── answer-option.schema.spec.ts   # NEW — contract tests (bounds, max 5, strict, default)
├── callback-tools.schema.ts       # RequestHumanSchema += options?
├── report.schema.ts               # ReportHumanTaskSchema += options?
├── human-queue.schema.ts          # HumanQueueItemSchema += options (nullable)
└── index.ts                       # export the new module

libs/database/src/schema/human-tasks.ts   # += options jsonb (nullable)
drizzle/0006_human_task_options.sql       # generated by drizzle-kit
drizzle/REVIEW-0006_human_task_options.md # review vs architecture.md §3
drizzle/meta/                             # 0006_snapshot.json + _journal.json

libs/callback/src/callback.service.ts     # scrub options in human(); pass through in scrubReport()
libs/human-tasks/src/human-task.service.ts# CreateHumanTaskInput += options; insert
libs/runs/src/runs.service.ts             # createHumanTask (needs_human path) persists options
apps/backend/src/dashboard/human-tasks.controller.ts # select + serve options
libs/jira/src/adf-composer.ts             # buildHumanTaskComment += bulletList of options
libs/executors/src/claude-cli/wrapper.ts  # callbackToolsSection: one added sentence
libs/executors/src/mock.executor.ts       # needs_human scenario variant with options
libs/pipeline/src/handoff.ts              # setup protocol: one line suggesting options (optional polish)

apps/web/src/views/HumanQueue.vue                       # option buttons in drawer footer slot
apps/web/src/components/HumanQueue/HumanTaskRow.vue     # "N options" hint (optional polish)
apps/web/test/human-queue.spec.ts                       # existing suite stays green untouched
apps/web/test/human-task-options.spec.ts                # NEW — buttons render/fill/custom text

test/integration/human-task-options.integration.spec.ts # NEW — end-to-end loop
docs/architecture.md                      # §3 column, §5 request_human, §6 human_task.options
docs/plan-internal.md, docs/progress.md   # iteration row + checkpoint entry
```

**Structure Decision**: existing monorepo layout; one new contracts module, one
new web component-test file, one new integration suite — everything else edits
files in place.

## Complexity Tracking

No constitution violations — table intentionally empty.
