# Quickstart / Validation — Jira Core (iteration 2)

How to prove the iteration works. The automated suite runs against mock Jira +
real Postgres/Redis; the live smoke is the manual DoD gate. No real Jira in
automated tests.

## Prerequisites

- Node 22 LTS, pnpm, Docker running (testcontainers spins one shared
  Postgres 16 + one shared Redis per run — see `test/integration/global-setup.ts`).
- New deps installed: `p-queue` (runtime), `msw` (dev).

## Static + unit + integration

```bash
pnpm typecheck && pnpm lint && pnpm test        # static + unit (ADF snapshots, rate-limiter, transition cache, config)
pnpm test:integration                            # full mock-Jira suites
```

Expected integration coverage (each proves specific FRs / success criteria):

| Suite | Proves |
|---|---|
| `jira-client.spec.ts` | per-issue writes serialized under concurrency (SC-003); 429+Retry-After honored, no attempt burned (SC-004); `/search/jql` pagination |
| `pipeline-loop.spec.ts` | status change → enqueue → mock run → transition + ADF comment for success/failure/needs_human; running-status transition at job start; NoTransitionPath → run failed (SC-001, SC-005, closes F2) |
| `reconcile-catchup.spec.ts` | 1-hour outage → exactly N triggers, repeat pass → 0 (SC-002) |
| `board-scope.spec.ts` | scrum no-sprint idle; scope-entry fires once; sprint switch rescans issues whose `updated` never changed; kanban unchanged (SC-009) |
| `dependency-gate.spec.ts` | blocked ticket → no run; blocker → Done → next pass fires exactly once (SC-010) |
| `scope-jql.spec.ts` | `scope_jql = "labels = ai-pipeline"` → unlabeled tickets never trigger (SC-011 filter half) |
| `watchdog-drift.spec.ts` | run past timeout+grace → failed + failure treatment (SC-006); persisted-but-unwritten result → Jira write re-applied, no duplicate run (SC-007) |
| `config-forward-compat.spec.ts` | full documented §0.1 example validates + boots (SC-011 config half, FR-039) |

Referenced details: interfaces in [contracts/contracts.md](contracts/contracts.md);
schema delta + JQL/gate logic in [data-model.md](data-model.md); decisions in
[research.md](research.md).

## Phase-level checkpoint (before live smoke)

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration` all green.
- [ ] Migration `0001_jira_board.sql` applies from scratch; `REVIEW-0001` signed off vs architecture §3.
- [ ] `docker compose up --build` boots the four services with the extended config.
- [ ] No import-time Jira/Redis connection (grep: no client built in a `@Module()` arg).

## Live smoke (manual DoD gate — FR-026)

Against a **real test Jira project** with a dedicated **bot account + API token**:

1. Seed a workspace pointing at the test project's **board id** (kanban or
   scrum), bot email + token; boot backend (introspects board type) + worker.
2. Configure one agent (mock executor): `trigger_status` → `status_running?`
   → `status_success` / `status_failure` matching real board statuses.
3. Move one ticket into the trigger status.
4. **Observe**: reconcile poll triggers a mock run → ticket transitions to the
   success status → a rendered ADF checklist comment appears in Jira.
5. Record the run in `docs/progress.md` (iteration-2 entry) noting **F2 and F3
   closed**.

**Done when**: all integration suites green on mock Jira; the 1-hour catch-up
proves no lost events; per-issue serialization proven under concurrency; the
live smoke executed and recorded (spec Success Criteria SC-001…SC-011).
