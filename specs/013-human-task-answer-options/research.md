# Research — Suggested Answer Options on Human Tasks (013)

No NEEDS CLARIFICATION markers survived the spec (the feature description carried
user-confirmed decisions). Research below records the design decisions and the
codebase facts they rest on.

## D1 — One schema home: `answer-option.schema.ts` in `packages/contracts`

**Decision**: a new dep-free module `packages/contracts/src/answer-option.schema.ts`
exports `AnswerOptionSchema` (`.strict()`, `.describe()` on every field) and
`AnswerOptionsSchema = z.array(AnswerOptionSchema).min(1).max(5)`. Both intake
schemas (`RequestHumanSchema`, `ReportHumanTaskSchema`) and `HumanQueueItemSchema`
import it.

**Rationale**: the option shape must be byte-identical across the tool input, the
report payload, and the queue API — one exported schema is the only way that
stays true (mirrors how `HUMAN_TASK_KINDS` is shared today). `report.schema.ts`
must not import from `callback-tools.schema.ts` (the dependency already points
the other way), so the shared shape gets its own module.

**Alternatives considered**: defining it inline in `report.schema.ts` and
re-importing — rejected: couples the queue API to the report module and buries a
cross-surface contract inside an unrelated file.

## D2 — Bounds and semantics

**Decision**: `{ label: string ≤80 (required), value?: string ≤500, description?: string ≤200 }`,
1–5 items, `.strict()`. `min(1)` on `label`/`value`/`description` so empty strings
are rejected. `value` defaults to `label` **at click time in the UI**, documented in
`.describe(...)` — the schema does NOT materialize the default (no `.default()`),
so storage shows exactly what the agent sent.

**Rationale**: bounds are user-confirmed. Not materializing the default keeps
intake lossless and makes "value omitted ⇒ label submitted" a display-layer rule
with a single implementation point (the button click handler), rather than a
storage transformation that would bloat every stored row with duplicated text.

**Alternatives considered**: `.default(label)` via transform at intake —
rejected: zod object defaults can't reference sibling fields without a transform
that changes the inferred type, and duplicating label into value in storage adds
noise for zero benefit.

## D3 — `min(1)` on the array; omission is the "no options" signal

**Decision**: `options` is `.optional()` on both intake surfaces; when present it
must have 1–5 items. `options: []` is a 422.

**Rationale**: an empty array is a meaningless third state ("present but empty")
that every consumer would have to normalize; rejecting it keeps NULL as the
single no-options representation (spec edge case).

## D4 — Storage: nullable jsonb, no CHECK constraint

**Decision**: `human_tasks.options jsonb` nullable, written only by the two
scrub-guarded intake paths (`HumanTaskService.createFromRequest`,
`RunsService.createHumanTask`); system-composed tasks never pass options ⇒ NULL.
Validation lives in zod at intake (both writers persist only schema-validated,
scrubbed payloads), matching how `runs.report` / `agents.behavior` jsonb are
handled today.

**Rationale**: consistent with the repo's jsonb precedent; a DB-level JSON CHECK
would duplicate the zod contract and drift. Migration `0006` is drizzle-kit
generated + `REVIEW-0006` against `docs/architecture.md` §3, amended in the same
change (CLAUDE.md rule 5).

**Alternatives considered**: a separate `human_task_options` table — rejected:
the list is bounded (≤5), immutable after creation, and always read with its
task; a join table buys nothing but a second query.

## D5 — Scrubbing point: `callback.service.ts`, both paths

**Decision**: `human()` scrubs each option's `label`/`value`/`description` before
calling `HumanTaskService`; `scrubReport()` does the same for
`human_task.options` on the report path. `HumanTaskService`/`RunsService` keep
their existing "caller has scrubbed" contract (documented on
`CreateHumanTaskInput`).

**Rationale**: identical placement to `title`/`details` today — one scrub point
per intake surface covers persistence AND the downstream Jira comment (built from
already-scrubbed input), preserving Constitution V without touching the composer.

## D6 — Jira mirror: ADF `bulletList` in `buildHumanTaskComment`

**Decision**: when options are present, append a `paragraph('Suggested answers:')`
plus a `bulletList` — one `listItem` per option rendering `label`, with
` — description` appended when present. `value` is NOT rendered in Jira.

**Rationale**: the comment is for humans reading Jira; `label`/`description` are
the human-facing texts, while `value` is the machine-submitted string (often
identical to label) — rendering it would duplicate noise. Composer stays pure and
deterministic ⇒ extend the existing snapshot tests. Without options the output is
byte-identical to today (snapshot asserts that).

**Alternatives considered**: numbered list (`orderedList`) — rejected: numbers
imply the operator can "reply 2" in Jira, which is not how answering works
(dashboard-only).

## D7 — UI: buttons fill the draft, submit stays explicit

**Decision**: option buttons render in `HumanQueue.vue`'s footer slot (where the
resolve form and its draft state already live), above the answer textarea, only
for OPEN tasks (`filter === 'open'`). Click ⇒ `draftFor(item.id).answer =
option.value ?? option.label`; last click wins; text stays editable; Submit is
the existing button. `HumanTaskDrawer.vue` stays presentational and gains
nothing — the buttons are form state, and all form state lives in the parent by
the drawer's own design comment. Buttons: `el-button` plain, label as text,
`description` as native `title` tooltip + secondary line. Closed tasks and
options-less tasks render exactly as today. Optional polish: `HumanTaskRow`
shows a small "N options" hint.

**Rationale**: keeping the drawer presentational preserves its draft-survival
behavior and its test surface; the footer slot already receives `item`, so the
buttons need no new props or emits.

## D8 — Agent-facing prose: one sentence, one optional handoff line

**Decision**: `callbackToolsSection()` gains one sentence on the `request_human`
bullet: options may be attached (array of `{label, value?, description?}`, max
5, value defaults to label, also accepted on `complete_task`'s `human_task`) —
offer them whenever the answer is a choice, not an essay. The workspace-setup
handoff protocol (`handoff.ts`) gains one line suggesting options for setup
questions ("Minimal team / Full team / …"). Stored agent instructions are not
edited (spec FR-011); `structuredOutputSection()` (Phase-0 byte-for-byte
contract) is untouched.

**Rationale**: the MCP tool schema itself (with its `.describe()` texts) is what
agents see at call time; the wrapper sentence is discovery. The handoff line is
the user-suggested optional mention, placed where setup agents actually ask
questions.

## Codebase facts the plan rests on

- `RequestHumanSchema` / `ReportHumanTaskSchema` are both `.strict()` zod objects
  in `packages/contracts` (zod 4); `CallbackService.human()`/`complete()` are the
  only intake validators; 422 on parse failure leaves the run untouched.
- `human_tasks` writers: `HumanTaskService.createFromRequest` (tool path +
  system-composed via `createNonBlocking`/PR-review) and
  `RunsService.createHumanTask` (`needs_human` report path). Both must persist
  options; system-composed callers simply never pass them.
- `HumanTasksController.list` serves BOTH the global queue and the workspace tab
  from one select ⇒ one added column serves both (spec FR-006).
- Resolution flows through `ResolveHumanTaskSchema.answer` (string ≤4000) into
  `resume.service.ts` → `trigger_event.resolution` → `handoff.ts` Q&A — all
  untouched (value ≤500 fits the 4000 cap with headroom).
- `buildHumanTaskComment` is only called from `HumanTaskService`
  (blocking-with-ticket path); it already takes the scrubbed
  `CreateHumanTaskInput`, so widening that input carries options in for free.
- Mock executor scenarios ride in `runs.trigger_event.mock_scenario`;
  `needs_human` returns a fixed report — options for the new variant can ride in
  a new optional `trigger_event` field (mirrors `mock_delay_ms`/`target_agent`
  precedent) without touching the queue payload contract.
- Migration head is `0005`; next is `0006` (drizzle-kit generate).
