# Data Model — Suggested Answer Options on Human Tasks (013)

## Answer option (value object, `packages/contracts/src/answer-option.schema.ts`)

| Field | Type | Constraints | Semantics |
|-------|------|-------------|-----------|
| `label` | string | required, 1–80 chars | Button text — the human-facing name of the choice. |
| `value` | string | optional, 1–500 chars | The string submitted as the answer when the button is clicked. Omitted ⇒ the UI submits `label` (display-layer default, not materialized in storage — research D2). |
| `description` | string | optional, 1–200 chars | Secondary hint under/behind the button; also rendered in the Jira mirror list. |

- Object is `.strict()` — unknown keys ⇒ 422 at intake.
- `AnswerOptionsSchema = z.array(AnswerOptionSchema).min(1).max(5)` — an empty
  array is invalid; "no options" is expressed by omitting the field (research D3).
- All three fields are free text ⇒ scrubbed at intake (Constitution V, research D5).
- No uniqueness constraint across options (spec edge case: duplicates allowed).

## Where the shape appears

| Surface | Field | Presence |
|---------|-------|----------|
| `RequestHumanSchema` (tool input) | `options?: AnswerOption[]` | optional |
| `ReportHumanTaskSchema` (`needs_human` payload) | `options?: AnswerOption[]` | optional |
| `HumanQueueItemSchema` (queue API) | `options: AnswerOption[] \| null` | always present, null when none |
| `TriggerEventSchema` | `mock_options?: AnswerOption[]` | test-only parameterization of the mock executor's `needs_human` scenario (rides in `trigger_event` like `mock_delay_ms`/`target_agent`; `.passthrough()` schema, typed optional field) |

## `human_tasks` table change (architecture.md §3, migration 0006)

```sql
ALTER TABLE "human_tasks" ADD COLUMN "options" jsonb;
```

| Column | Type | Nullable | Written by | Notes |
|--------|------|----------|-----------|-------|
| `options` | jsonb | YES (default NULL) | `HumanTaskService.createFromRequest` (tool path), `RunsService.createHumanTask` (`needs_human` report path) | Stores the scrubbed, schema-validated array verbatim. NULL for: all pre-existing rows, all system-composed tasks (PR review, triage-limit, orchestrator failure, team review), and any ask without options. Never updated after insert (options are immutable — v1 cut). No DB-level JSON validation — zod at intake is the contract (research D4). |

No new index: options are only ever read alongside their row (list select), never
filtered on.

## State & lifecycle

- Options are set once at task creation and never mutated.
- Task resolution is UNCHANGED: `resolution` stays a plain string; a clicked
  option lands there via the existing `answer` field. No answer∈options
  validation (v1 cut).
- Closed tasks retain their `options` in storage (audit), but the UI renders no
  buttons for them (spec FR-012); the queue API serves the field regardless of
  status — the client decides.
