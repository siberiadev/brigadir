# Quickstart — validating Suggested Answer Options (013)

## Prerequisites

- `pnpm install`; Docker running (testcontainers + compose).
- Contracts: [contracts/answer-options.md](./contracts/answer-options.md);
  shape: [data-model.md](./data-model.md).

## Gates (must all pass)

```bash
pnpm typecheck && pnpm lint && pnpm test   # statics + unit/contract (incl. ADF snapshots, web MSW tests)
pnpm test:integration                      # real Postgres/Redis via testcontainers
```

## What the new suites prove

| Suite | Proves |
|-------|--------|
| `packages/contracts/src/answer-option.schema.spec.ts` | bounds (80/500/200), 1–5 items, `.strict()` rejects extras, options optional on both intake schemas + present on `HumanQueueItem` |
| `test/integration/human-task-options.integration.spec.ts` | `request_human` with options ⇒ `human_tasks.options` persisted ⇒ queue item carries them ⇒ resolving with an option's `value` lands in `resolution` and the resumed run's handoff renders the Q&A; canary secret in a label is scrubbed; system-composed tasks have `options IS NULL`; mock `needs_human` variant emits options via `trigger_event.mock_options` |
| `libs/jira/src/adf-composer.spec.ts` (extended) | question-comment snapshot WITH options (bullet list) and WITHOUT (byte-identical to today) |
| `apps/web/test/human-task-options.spec.ts` | buttons render for a task with options; click fills the answer input (`value ?? label`), no auto-submit; custom text still submittable; no buttons when `options` is null |
| existing `human-queue.spec.ts` / resume / answer-triage suites | stay green untouched — regression guard for FR-009/SC-002/SC-004 |

## Manual end-to-end (compose)

1. `docker compose up --build`; open the dashboard.
2. Trigger a mock run with `trigger_event.mock_scenario = "needs_human"` and
   `mock_options` set (or drive `POST /api/callbacks/runs/:id/human` with a run
   JWT and an `options` array).
3. Human queue → open the task: option buttons above the answer field.
4. Click an option → the textarea fills with its `value` (or `label`); nothing
   submits.
5. Press Submit (Resume) → task closes with that string as resolution; the
   resumed run's prompt contains `Question: …` / `Answer: <value>`.
6. Ticketed blocking ask: the Jira issue's question comment lists the options
   under "Suggested answers:".
7. A task created without options (e.g. mock PR-review task) renders exactly as
   before — no buttons, no new UI.

## Expected outcomes

- SC-001: answering an option-carrying question = 2 clicks.
- SC-002/004: no visual or behavioral change anywhere options are absent; the
  resolve request payload is indistinguishable from a typed answer.
- SC-005: a 6-option / oversized / extra-key payload gets a 422 and the run
  stays running.
