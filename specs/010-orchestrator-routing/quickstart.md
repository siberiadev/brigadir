# Quickstart: Validating Orchestrator-Based Blocked-Ticket Routing

End-to-end validation of the fail → triage → route → rework → success loop and its guards, using the
**mock executor** (Constitution VI — no live agents). References `spec.md` (FR/SC), `data-model.md`,
and `contracts/`.

## Prerequisites

- Docker running (testcontainers spin up Postgres 16 + Redis for integration tests).
- `pnpm install` done.
- Migration `drizzle/0004_orchestrator_routing.sql` applied (integration harness runs the migrator).

## Static checks

```bash
pnpm typecheck && pnpm lint && pnpm test        # contracts + unit
pnpm test:integration                            # testcontainers (Docker required)
```

Expected: green, including the new `report.schema`, `trigger-event.schema`, `handoff`, pipeline,
resume, seeding, and global-settings suites.

---

## Scenario 1 — Happy loop: fail → triage → route → rework → success (US1, SC-007)

**Setup**: a workspace with an enabled orchestrator ("brigadir") and two worker agents (Developer,
Reviewer), each on the mock executor; a ticket in flight.

1. Drive a worker run to `failure` (mock scenario `failure`).
2. Assert (FR-004, AC US1-1): ticket transitioned to the agent's failure status, failure comment
   posted, and **exactly one** triage run enqueued for the orchestrator (`source='triage'`).
3. Inspect the triage run's assembled prompt (FR-012, AC US1-2): contains failing summary,
   failed/warning checks, artifacts, worker roster (name + description), cycle count vs max, and the
   decision protocol — while the orchestrator's stored `instruction` row is unchanged.
4. Complete the triage run with mock scenario `routed` targeting "Developer" + a rework task.
5. Assert (FR-008, AC US1-3): a rework run (`source='rework'`) is created for Developer, ticket →
   Developer's `status_running` (no trigger-status passthrough), routing comment posted naming the
   target + task.
6. Inspect the rework run's prompt (FR-012, AC US1-4): contains the orchestrator's task, failing
   summary + failed checks, branch/PR, and fix-of-existing-work framing; Developer's stored
   `instruction` unchanged (SC-002).
7. Drive the rework run to `success` ⇒ ticket reaches the success status. Loop closed.

**Replay (SC-001, AC US1-5)**: re-invoke completion processing for the original failed run (drift
repair) ⇒ no second triage run (marker guard).

---

## Scenario 2 — Budget cap & human fallback (US2, SC-003)

1. With `rework_max=2`, drive the ticket through 2 rework cycles, then fail again.
2. Assert (FR-005, AC US2-1): no triage run; a **non-blocking** human task is created; the decision is
   recorded on the run timeline.
3. Invalid target (AC US2-2): complete a triage run with `routed` naming a disabled/nonexistent/
   orchestrator target ⇒ overridden into a human task carrying the task text + override reason.
4. Budget-raced (AC US2-3): valid `routed` but budget exhausted meanwhile ⇒ overridden to human task.
5. Orchestrator failure (AC US2-4): drive the triage run itself to `timeout`/`failure` ⇒ **no** second
   triage (the triager is never triaged) + a human task describing the orchestrator failure.
6. Non-orchestrator routing (AC US2-5): a worker agent returns `routed` ⇒ treated as failure, invalid
   outcome noted in the Jira comment (FR-002).

---

## Scenario 3 — Human resume with agent picker (US3, SC-004)

1. Park a run via a blocking `request_human`.
2. `POST /api/human-tasks/:id/resolve` with `action='resume'`, an `answer`, and **no**
   `target_agent_id` ⇒ new run for the original agent, prompt contains the task title/details + answer
   (AC US3-1).
3. Resolve another parked task with `target_agent_id` = a different enabled agent ⇒ new run for that
   agent (attempt restarts at 1), ticket → chosen agent's running status (AC US3-2).
4. Resolve with a non-existent/disabled/other-workspace agent id ⇒ 400, nothing changes (AC US3-3).
5. UI: on a blocking task, the resolve panel's agent selector lists the workspace's enabled
   non-orchestrator agents with the original preselected (AC US3-4).

---

## Scenario 4 — Orchestrator lifecycle & central default (US4, SC-005/006)

1. Create a workspace via the wizard ⇒ a "brigadir" orchestrator exists, never poll-triggered, with
   the current default instruction copied in (AC US4-1).
2. Startup backfill: on a DB with a pre-existing workspace lacking an orchestrator, boot ⇒ the
   workspace is backfilled with one (insert-if-absent; AC US4-2).
3. Attempt to delete the orchestrator via API ⇒ 409; UI shows no delete action. Editing its
   instruction/timeout/enabled still works (AC US4-3, FR-019).
4. `PUT /api/general-settings` with a new default instruction, then create another workspace ⇒ the new
   workspace's orchestrator uses the new default; existing orchestrators unchanged (AC US4-4, SC-006).
5. Edit an orchestrator's instruction, run a triage ⇒ the edited instruction is used and the protocol +
   roster still arrive via the handoff section (AC US4-5).

---

## Success criteria mapping

| Criterion | Validated by |
|-----------|-------------|
| SC-001 exactly-one triage + replay-safe | Scenario 1 steps 2, replay |
| SC-002 rework prompt carries context, zero instruction change | Scenario 1 step 6 |
| SC-003 never exceed rework max, all fallback paths → human | Scenario 2 |
| SC-004 operator picks any worker agent, prompt has Q&A verbatim | Scenario 3 |
| SC-005 every workspace has orchestrator; delete fails, edit works | Scenario 4 steps 1–3 |
| SC-006 default change affects only new workspaces | Scenario 4 step 4 |
| SC-007 full loop under mock executor with Jira status/comments | Scenario 1 |

Full functional coverage lives in the co-located `*.spec.ts` unit suites and the
`test/integration/` loop tests; this guide is the runnable validation path, not the test source.
