# Quickstart — validating sprint-sequencing (022)

Validation scenarios proving the feature end-to-end. Implementation details live in [plan.md](plan.md) / [research.md](research.md); the automated equivalents land in `test/integration/` in the same iteration (Principle VI).

## Prerequisites

- Docker running (testcontainers Postgres 16 + Redis; integration harness `test/integration/global-setup.ts` shares containers per run).
- `pnpm install`, then `pnpm typecheck && pnpm lint && pnpm test` green before starting.
- Integration suite: `pnpm test:integration` (mock-jira MSW harness — no live Jira needed).

## Scenario 1 — chain walks itself (SC-001, spec Story 1)

Automated: extended `test/integration/dependency-gate.spec.ts`.

1. Seed agent with trigger status `Ready`, `status_success: Done` (mock scenario `success`); seed tickets A, B, C with links B←A, C←B (mock-jira `addBlockedByLink`); move all three to `Ready`.
2. Drive reconcile passes; let runs complete.
3. Expect: A runs first; B triggers only after A's transition to Done (via fast path immediately, or next pass at the latest); then C. Exactly 3 runs total (dedup holds, SC-003). Human-completion variant: complete a blocker via mock-jira directly (no run) → dependent triggers on the next pass.

## Scenario 2 — priority wave order (SC-004, spec Story 2)

1. Seed B (priority id 2/High), C (id 4/Low), D (no priority), all blocked only by A, all in `Ready`.
2. Complete A; run a release pass.
3. Expect trigger order B → C → D (priority ASC, NULLS LAST; equal-priority pairs order by `jira_key`). Repeat the scenario 10× in the test loop — identical order every time.

## Scenario 3 — waiting visibility (SC-005, spec Story 3)

1. With B blocked by open A and C, hit `GET /api/workspaces/:id/waiting` (contract: [contracts/dashboard-waiting.md](contracts/dashboard-waiting.md)).
2. Expect one item: `jira_key=B`, `blocked_by=[A, C]`, `blocked_state='waiting'`, priority fields populated.
3. Complete A and C; after the release pass B triggers and the list is empty.
4. Manual check: `/workspaces/:id/waiting` tab shows the row with state tag; pagination appears only when `total > 10`.

## Scenario 4 — diagnostics (SC-006, spec Story 4)

- **Cycle**: tickets X⇄Y blocking each other, both in `Ready` → no runs; both rows get `blocked_state='cycle'`.
- **Dead-end**: blocker resolved as Won't-Do-style into a NON-done category (mock: status w/ `resolution` set, category `indeterminate`) → dependent `blocked_state='dead_end'`, no run, no human task.
- **Out-of-scope**: blocker key from another project (`OTHER-1`) or outside the scrum sprint scope → dependent `blocked_state='out_of_scope'` **and** exactly one open run-less human task for the ticket; a second pass creates no duplicate; resolving the task without fixing the board → recreated on a later pass (condition persists); breaking the link on the board → state clears, normal path resumes.
- **Done-category resolution** (control): blocker closed as Won't Do INTO the done category → dependent releases normally (completion category is the single source of "done").

## Scenario 5 — fast path (FR-003)

1. B blocked by A only; A's run succeeds → system transitions A to Done.
2. Expect B's run enqueued in the same finalization (no reconcile pass in between) — asserted by triggering `onRunFinished` directly and checking B's run exists before any explicit `reEvaluateDependencies` call.
3. Kill-switch check: fast-path failure (mock Jira 500 on the dependent fetch) must NOT fail A's finalization; B still releases on the next reconcile pass.

## Guard-rail checks (must stay green)

- `runs_one_active`, BullMQ dedup, webhook dedup untouched — existing idempotency tests pass unchanged.
- `scope-jql.ts` moved file-wholesale to `libs/jira` — `sinceClause` format tests and the mock-jira silent-empty regression test pass unchanged.
- Existing `dependency-gate.spec.ts` T057/T066 assertions unchanged (release loop extended, not rewritten).
- `docs/architecture.md` §3 diff reviewed against the actual migration SQL (rule 5).

## Full stack smoke

```bash
docker compose up --build     # postgres, redis, backend, worker
# seed a workspace + agent via dashboard/admin-MCP; lay A→B→C on the board; watch the Waiting tab drain as runs complete
```
