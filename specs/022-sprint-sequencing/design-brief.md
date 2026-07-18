# Design Brief — sprint-sequencing (verbatim input)

> Original feature description as provided. The spec ([spec.md](spec.md)) is the
> normative document; this brief preserves the author's implementation pointers
> and constraints that the spec deliberately keeps out of its requirement
> language.

# Feature — sprint-sequencing: guaranteed execution order for tickets chained via blocked-by

## Problem (the core issue is a bug, not an enhancement)

The dependency gate (`libs/pipeline/src/dependency-gate.ts`) is evaluated exactly once — at the moment a ticket changes status (`libs/pipeline/src/pipeline.service.ts:81`). If ticket B enters a trigger status while blocked (it has an inward "is blocked by" link to an unresolved A), the trigger is silently skipped — one log line, nothing persisted. When blocker A later transitions to done, B's status does not change → the reconcile poller (`libs/ingest/src/poller.service.ts`, diffs `last_seen_status`) produces no event → `onStatusChanged(B)` is never called → **B will never trigger** unless a human manually toggles its status back and forth.

Consequence: the scenario "a human lays out a sprint as a chain A→B→C via blocked-by links and the system walks through it on its own" fundamentally does not work today. Fixing this is the core of the feature.

## What is needed

1. **Unblock re-check.** When a ticket transitions into the `done` status category, the system re-evaluates the tickets it was blocking and triggers those that currently sit in some agent's trigger status and have become `clear` per the gate. The data is already available: the poller fetches `issuelinks` (`POLL_FIELDS` in `libs/ingest/src/scope-jql.ts`) — a completed ticket A carries outward `blocks` links to its dependents. Must handle: a dependent may have multiple blockers (trigger only when clear on ALL of them); duplicate triggering is already prevented by the existing dedup (partial unique index `runs_one_active` on `(ticket_id, agent_id)` — do not touch it); a blocker's completion can arrive either via the poller or via the transition the system itself performs after a successful run (`status_success`) — both paths must lead to the re-check.

2. **Deterministic order among simultaneously unblocked tickets.** Today the order is whatever the JQL returns (`ORDER BY updated ASC`) plus executor concurrency — effectively random. Introduce a deterministic launch order based on Jira priority (the `priority` field is currently absent from both `POLL_FIELDS` and the `tickets` table — add it to both; on equal priority use a stable tiebreaker, e.g. `jira_key`). Attention: changing the `tickets` table requires a synchronized update of `docs/architecture.md` §3 (hard-won rule 5 in CLAUDE.md).

3. **Visibility for blocked tickets.** A blocked ticket must be visible in the dashboard as "waiting on [A, C]" rather than silently skipped. Also guard against silent deadlocks: a blocker stuck in a status outside the `done` category that will never close (Won't Do etc.), and cycles A→B→A, must at least be diagnosable (warning in UI/logs); breaking the cycle remains a human decision.

4. **(Raise during clarify, may be deferred)** A cap on concurrent runs within one epic/one chain — so a wave of N simultaneously unblocked tickets does not pile into the same repository in parallel. If it bloats the scope, record it as an explicitly deferred decision.

## Explicit non-goals (keep out of this spec)

- Planner / agent-driven ticket creation from an epic — deferred by a separate decision.
- Cross-project reading of knowledge/contracts (data models) — future feature 021.
- Repository filtering via the ticket's Components field — already in progress as separate work on top of 019 (multi-repo runs); this feature must not conflict with it on schema.

## Constraints and existing mechanics to respect

- Only the system writes to Jira (transitions + ADF comments via the per-issue write queue) — nothing in this feature gives agents write access.
- Runs are non-idempotent: `maxStalledCount: 0` and the three dedup layers stay intact.
- Finalization guards (`WHERE status='running'`) must not be weakened by the re-check path.
- Tests land in the same iteration as the functionality; integration tests run against real Postgres/Redis (testcontainers).
- The poller's HWM/JQL quirks are load-bearing (see comments in `scope-jql.ts`) — do not reformat the `since` clause.

## Acceptance scenario (end-to-end)

A sprint contains tickets A, B, C with links B "is blocked by" A, C "is blocked by" B. All three are moved into the agent's trigger status at once. The system: triggers only A; shows B and C as waiting with their blocker keys; after A's run succeeds and A transitions to done, automatically triggers B without any human action; then C after B. If B and C had both been blocked only by A, on A's completion they launch in priority order.
