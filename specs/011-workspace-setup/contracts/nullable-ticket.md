# Contract: Ticketless runs & human tasks (nullable ticket)

The cross-cutting delta behind setup runs (D2/D3/D4/D16). Every consumer of a run's or
human task's ticket learns exactly one new case: `ticket === null` ⇒ "workspace setup".

## Database

- `runs.ticket_id`, `human_tasks.ticket_id`: `NOT NULL` dropped, FK kept (migration 0005).
- New partial unique index `runs_one_active_setup (workspace_id) WHERE active AND ticket_id IS NULL`.
- `runs_one_active` untouched (NULLs are distinct — it cannot and need not cover setup runs).

## Read-path inventory (inner join → left join + null tolerance)

| Site | Today | Becomes |
|------|-------|---------|
| `runs.controller.ts:60,78` list+count | `innerJoin(tickets)` — ticketless rows **dropped from list & total** | left join; `ticket: null` serialized |
| `runs.controller.ts:155` card | inner join — ticketless run **404s** | left join; `ticket: null`; no deep link; history by ticket skipped for null |
| `runs.controller.ts:52` ticket ilike filter | inner-match | unchanged (NULL never matches; `source` filter is the finder) |
| `human-tasks.controller.ts:64` list | inner join — ticketless tasks dropped | left join; `ticket: null`; `jira_url` omitted |
| `apps/worker/claude-cli-run.processor.ts:334` `load()` | inner join — job silently dropped | left join; `ticket: null` context |
| `apps/worker/run.processor.ts:188` `load()` (mock) | inner join | left join |
| `human-task.service.ts` `transitionAndComment` | loads ticket by id | null ticket ⇒ skip Jira entirely (park/insert still happen) |
| `handoff.ts` / `rework-budget.ts` | key off failing run's ticket | unreachable for setup (no triage) — null-guard anyway, degrade to `''`/skip |

## Executor / prompt layer

- `RunContext.ticket` → nullable (`agent-executor.interface.ts:21`).
- `buildWrapperText` branches on null ticket → workspace-setup header; ticket sections omitted
  (`wrapper.ts:57`); `featureContextSection` skipped.
- `fetchTicketDetail` skipped for null ticket (worker processors).
- Worktree: setup runs run on the orchestrator profile (`workspace_mode:'none'`) — the branch
  name `<prefix>/<ticketKey>` path is never reached; `prepare()` keeps its non-null `ticketKey`
  signature.
- Run JWT: `tkt` claim optional (`run-token.ts`); guard unchanged (never checked `tkt`).

## Contracts (`packages/contracts`)

- `RunListItem.ticket`, run-card ticket → `.nullable()` (`runs.schema.ts`).
- `HumanQueueItem.ticket` → `.nullable()` (`human-queue.schema.ts`).
- `TriggerEventSchema`: source `workspace-setup` (+ `human_task_id`/`resolution` reuse).
- `RunTokenClaims.tkt?`.

## Web (null guards + label)

`Runs.vue:139-141`, `RunCard.vue:121-122`, `HumanTaskRow.vue:49-53`, `HumanTaskDrawer.vue:33-35`:
`ticket === null` → static **Workspace setup** label (no `<a>`), everything else renders as
usual. MSW fixtures gain ticketless variants (`apps/web/test/handlers.ts`).

## Invariants preserved

- Ticketed behavior is byte-for-byte unchanged (left join serializes identically when a ticket
  exists; no backfill).
- `runs_one_active` semantics for ticketed runs unchanged.
- Constitution I: Jira remains truth for ticket status — setup runs simply have no ticket and
  therefore no Jira side; Postgres remains truth for the run itself.
