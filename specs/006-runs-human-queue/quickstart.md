# Quickstart — Runs Visibility & Human Queue (validation guide)

How to prove feature 006 works end-to-end. Detailed request/response shapes live in
`contracts/*.md`; entities in `data-model.md`; decisions in `research.md`. This file is a
run/validation guide, not implementation.

## Prerequisites
- `docker` running (integration tests use testcontainers: real Postgres 16 + Redis).
- `pnpm install` done; workspace builds green.
- Env: `BRIGADIR_DASHBOARD_TOKEN`, `BRIGADIR_CREDENTIALS_KEY` (feature 005), Postgres/Redis
  URLs — see `docs/local-setup.md`.

## Commands
- `pnpm typecheck && pnpm lint && pnpm test` — statics + unit + Vue component tests.
- `pnpm test:integration` — backend endpoints + multi-workspace reconcile + concurrency
  re-apply (testcontainers + mock-jira, no broker mocks; per-suite `BULLMQ_PREFIX`).
- `docker compose up --build` — full stack; open the SPA the backend serves.

## Test patterns (follow the established harness)
- **Backend / worker** (Principle VI, CLAUDE.md rule 4): testcontainers against real
  Postgres/Redis + mock-jira. New-run trigger paths and the reconcile pass are pipeline
  logic → tests in the SAME change. Namespace suites by unique `BULLMQ_PREFIX` (rule 6).
- **Frontend**: Vitest + `@vue/test-utils` + jsdom + **msw** component tests, extending
  `apps/web/test/mount.ts` and `apps/web/test/handlers.ts`. Fake the API at the HTTP
  boundary with msw — not the store. Add msw handlers for the new runs / human-queue /
  executors endpoints.

---

## Scenario A — Clear the needs-human queue (US1, P1)
1. Seed open `human_tasks` of each kind (question/blocker/review; blocking + non-blocking)
   via the backend, one blocking task tied to an `awaiting_human` run.
2. Load the SPA; assert the human queue is the **default landing view** (count > 0, FR-002)
   and lists title, ticket key, agent, kind, age, blocking flag (FR-001).
3. Resolve the blocking task with `action: "resume"` + an answer → assert `200 { newRunId }`,
   the parked run is `superseded`, a new `queued` attempt exists, the ticket progresses
   (SC-004), and the task leaves the open list.
4. Resolve another with `done_manually` / `dismiss` → closed, no new run (FR-003).
5. Assert the navbar badge (`GET /api/human-tasks/count`) decrements within a few seconds
   without a manual refresh (SC-005) and closed tasks appear under the history filter with
   resolution + resolver (FR-006).

## Scenario B — Read a report & diagnose a run (US2, P1)
1. Seed a ticket with runs carrying `run_checks` in all four states (pass/fail/warn/skip),
   `run_events` (progress/tool_call/api_retry/jira_action), and a failed run with `error`.
2. Open `GET /api/runs/:id`; in the card assert ✅/❌/⚠/⏭ glyphs render, reasons expand
   (FR-008), the timeline is chronological (FR-010), run history shows agent/executor/
   attempt/duration/cost/outcome (FR-009), the header deep-links to Jira (FR-007), and a
   failed run shows diagnostics (FR-011, SC-003).
3. `POST /api/runs/:id/cancel` on a **running** run → flips to `cancelled`; assert it does
   **not** overwrite an `awaiting_human` run (constitution rule #7 / FR-012 — cancel of an
   `awaiting_human` run returns `cancelled:false`).
4. `POST /api/runs/:id/retry` on a finished run → new attempt via the manual-trigger path;
   assert a second active run is refused `409 active_run_exists` (FR-013, retry semantics).
5. Assert an open card reflects new events/status within a few seconds (polling, R1 / SC-005).

## Scenario C — Browse & filter runs (US3, P2)
1. Seed a workspace with runs across several agents and statuses.
2. `GET /api/workspaces/:id/runs` → paginated table (agent, ticket key+summary+Jira link,
   status, attempt, duration, cost — FR-015).
3. Apply `?agent=`, `?status=`, `?ticket=` → rows narrow, `total` reflects the filtered set
   (FR-016).
4. `GET /api/workspaces/:id/runs/cost?period=7d` → header total updates per period (FR-019,
   SC-010). Empty workspace → empty state, not an error (Edge Case).
5. Click a row → the US2 card opens (FR-018). Table updates live as a run changes status
   (FR-017).

## Scenario D — Administer executors, never an empty picker (US4, P2)
1. Create a workspace → assert exactly one `claude_cli` "claude" + one `mock` "mock" exist
   (FR-022, SC-006).
2. Open the agent form picker → names + type badges, defaults to `claude_cli`, never a UUID
   or empty list (FR-023).
3. Create/update/delete executors via `/api/workspaces/:id/executors`; assert the typed
   config form shows only the type's fields (mock: concurrency; claude_cli: model, cli_path,
   repository-from-workspace, callback toggle, keep-failed-worktrees toggle, max turns,
   concurrency) — FR-021.
4. Try to delete an executor referenced by an agent → `409 executor_in_use` naming the
   conflict (FR-024, SC-009).
5. Change `concurrency_limit` on a running worker → assert `worker.concurrency` reflects the
   new **sum** within ~15 s, no restart (FR-025, SC-008). Integration test may invoke the
   re-apply directly with a short interval.

## Scenario E — Poll every enabled workspace, isolate outages (US5, P2)
1. Two enabled workspaces + one disabled (`settings.enabled=false`). Run one reconcile pass →
   both enabled polled (each with own board scope / HWM / dependency re-eval / watchdog /
   drift), disabled skipped entirely (FR-026, FR-028, SC-007).
2. Make one enabled workspace's mock-jira fail → assert the healthy workspace's pass still
   completes (FR-029, SC-007).
3. Assert the per-workspace client is used: a call for workspace B hits B's site/credentials,
   not A's (FR-027).
4. Toggle a workspace's `settings.enabled` via `PUT /api/workspaces/:id/settings` → next pass
   includes/excludes it (FR-030).

---

## Acceptance roll-up
- Product pain #2 closed (SC-002): report readable as a checklist. **Scenario B**.
- Product pain #3 closed (SC-001): unified needs-human queue with resolution. **Scenario A**.
- Live updates within a few seconds, no manual refresh (SC-005): polling. **A/B/C**.
- Fresh workspace can create an agent immediately (SC-006). **Scenario D**.
- Multi-workspace polling with outage isolation (SC-007). **Scenario E**.
