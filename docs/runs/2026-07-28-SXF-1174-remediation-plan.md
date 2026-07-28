# SXF-1174 incident — remediation plan

Status: **analysis complete, no fixes applied yet.** Each problem below is intended to be
taken through its own plan-mode session + implementation, one at a time, in the listed order.

## Evidence base

All claims below were re-verified against the raw export in `docs/runs/data/`:

| File | Contents |
|---|---|
| `docs/runs/data/SXF-1174-dump.json` | Machine dump: workspace + settings, 5 agents, ticket, 11 runs (trigger_event / usage / report / error / checks), 527 run_events, 5 human tasks |
| `docs/runs/data/SXF-1174-timeline.txt` | Human-readable summary: run table, event profile per run, rework grouping by `deciding_run_id`, human tasks, errors |
| `docs/runs/data/SXF-1174-events.md` | All 527 events per run, raw payloads |
| `docs/runs/data/README.md` | Fact list + reproduction instructions |

Related post-mortem: `docs/runs/2026-07-28-run-b4d27e5e-brigadir-routing-loop.md`.

## Incident summary

One orchestrator decision (run `b4d27e5e`, source `answer-triage`, outcome `routed` →
target `heimdall-qa`) spawned **five** rework runs of heimdall-qa
(`49f595cf` 10:07, `4e013e29` 10:11, `e033adef` 11:14 failed, `c6d3bd1f` 11:24,
`7f2bd0cf` 11:26 — all on 2026-07-28). All five carry a byte-identical
`trigger_event` (`deciding_run_id=b4d27e5e`, task 3969 chars,
`human_task_id=153d413d`). Each new run appeared 12–20 s after the previous one
stopped being active (manual cancel or failure). ~$3.24 and ~1053 s of agent time
were wasted. In parallel, mimir-reviewer was legitimately re-triggered on the
ticket's `Review` status (`8a92fa06`, then `49779be1` 13 s after `8a92fa06` was
cancelled). The loop only stopped when the human paused the whole workspace
(`settings.enabled=false` @ 11:26:54 — which is AFTER the last run was created,
so the reconcile enabled-selector is NOT implicated; earlier suspicion of
`reconcile.service.ts:60` was a false alarm).

Root chain: in `processOrchestratorDecision` the rework run is enqueued **before**
the Jira transition; the Jira write threw (no diagnostic recorded — see Problem 2);
the `jira_action` completion marker (written after, in `onOrchestratorFinished`)
therefore never landed; drift repair replays any terminal run lacking the marker
on every reconcile pass; the only duplicate-guard is "one **active** run per
(ticket, agent)", so every time the previous rework run went terminal, the next
replay minted a new one. The rework budget (max 2) did not stop it because the
`answer-triage` origin exempts the decision from the budget on **every** replay.

---

## Problem 1 — Orchestrator decision replay mints unbounded rework runs

**Severity: critical (the core of the incident). Fix first.**

Three cooperating defects, all in `libs/pipeline/src/pipeline.service.ts`:

1. **Enqueue-before-Jira ordering.** `processOrchestratorDecision` calls
   `runTrigger.trigger(...)` at `libs/pipeline/src/pipeline.service.ts:526`
   and only then `jira.transitionTo(...)` / `addComment(...)` at `:540-544`.
   When the Jira write throws, a rework run is already enqueued, yet the
   decision is left unmarked and will be replayed.
2. **No `NoTransitionPath` handling on the orchestrator path.** The worker
   completion path catches `NoTransitionPath`, records a
   `run_events(type='error', stage='jira_transition')` diagnostic and returns
   (`libs/pipeline/src/pipeline.service.ts:369-383`). The orchestrator path
   (`onOrchestratorFinished`, `:435-449`) has no such catch: the exception
   escapes, the `jira_action` marker insert at `:443-447` is skipped, and no
   diagnostic of any kind is persisted (confirmed: run `b4d27e5e` has 16 events,
   zero `error` events, zero `jira_action` events — see timeline + dump).
3. **No replay-idempotency for the decision itself.** Re-entry into
   `processOrchestratorDecision` never checks whether a run with this
   `deciding_run_id` already exists (in any status). The only guard is the
   `runs_one_active` partial index inside `RunTriggerService.trigger`
   (`libs/runs/src/run-trigger.service.ts:102-121`), which dedups only while
   the previous rework run is still active (`queued|running|awaiting_human` —
   `libs/runs/src/run-trigger.service.ts:22`). Once it goes terminal, the next
   replay creates a fresh run.

**Evidence:** `SXF-1174-timeline.txt` — "REWORK RUNS SHARING ONE ORCHESTRATOR
DECISION" section (5 runs, identical trigger_event); `jira_action` column is 0
for all runs except `5890636f`; run creation timestamps trail each
cancel/failure by 12–20 s (one reconcile pass).

**Fix direction (for the plan session):** make the decision replay-idempotent —
check for an existing run with `trigger_event->>'deciding_run_id' = runId`
before triggering (any status counts); reorder so the Jira write happens before
(or transactionally with) the enqueue; mirror the worker path's
`NoTransitionPath` catch + error event on the orchestrator path so a
board-config fault is diagnosable and non-replaying (or deliberately replaying,
but only the Jira part). Tests belong in
`test/integration/orchestrator-routing-loop.integration.spec.ts`.

---

## Problem 2 — Jira failure on the orchestrator path leaves zero diagnostics

**Severity: high (observability; also part of Problem 1's defect 2).**

Because `onOrchestratorFinished` has no catch, the actual Jira error that
started the incident was never persisted anywhere — not on the run, not as a
`run_events` error. We still do not know the exact failure text; we only infer
"transition/comment threw" from the missing marker and the replay behaviour.
The reconcile step wrapper logs it to the worker's stdout only
(`libs/ingest/src/reconcile.service.ts:126-132`), which is lost.

**Fix direction:** persist an `error` run_event (stage `jira_transition` /
`jira_comment` / `orchestrator_completion`) on any throw in the orchestrator
completion path, same shape as the worker path at
`libs/pipeline/src/pipeline.service.ts:374-379`. May be folded into Problem 1's
implementation; kept separate here so the diagnostic requirement is not lost.

---

## Problem 3 — `answer-triage` budget exemption is re-granted on every replay

**Severity: high (the safety net that should have capped the loop at 2).**

`getReworkBudget` (`libs/pipeline/src/rework-budget.ts:22-39`) counts runs with
`trigger_event->>'source' = 'rework'` against `rework_max` (default 2). Five
rework runs far exceed it. But `processOrchestratorDecision` exempts the
decision when its own trigger source is `answer-triage`
(`libs/pipeline/src/pipeline.service.ts:498-503`, `humanGranted`). Intended
semantics: a human's answer grants ONE extra cycle. Actual semantics: the
exemption is a property of the (immutable) deciding run's trigger_event, so
every drift-repair replay of that decision re-grants it — the budget can never
stop the replay loop.

**Evidence:** 5 rework runs on the ticket vs `rework_max` default 2
(`SXF-1174-timeline.txt`); no `override_budget` decision or "Routing overridden"
human task in the dump.

**Fix direction:** the grant must be consumable — e.g. "human granted" counts
only if the number of rework runs with this `deciding_run_id` is zero, or the
exemption allows exactly `cycleCount < max + 1` instead of a blanket bypass.
Becomes moot for the replay case once Problem 1's idempotency lands, but the
blanket bypass is independently wrong (any future re-entry path re-grants it).

---

## Problem 4 — Drift repair aborts on first failing run, starving the rest

**Severity: high.**

`DriftRepairService.repair` iterates pending runs with no per-run try/catch
(`libs/ingest/src/drift-repair.service.ts:47-50`); the reconcile wrapper
catches only per-step (`libs/ingest/src/reconcile.service.ts:126-132`). The
first run whose `onRunFinished` throws aborts the whole loop. In this incident
the pending set was exactly {`b4d27e5e` (throws every pass), `e033adef`}, so
the failed QA run `e033adef` **never** received its failure treatment: no
transition to Blocked, no failure comment in Jira, no triage. It sat starved
behind the poisoned decision until the workspace was paused.

Note (correction to an earlier analysis): drift repair does NOT scan all 10
marker-less runs — `cancelled` and `superseded` are outside its
`TERMINAL_STATUSES` (`libs/ingest/src/drift-repair.service.ts:8`). Only
`b4d27e5e` and `e033adef` qualified.

**Evidence:** `e033adef` has 87 events, zero `jira_action`, zero `error`
events (`SXF-1174-timeline.txt` event profile); no triage run for the
orchestrator exists after e033adef's 11:23:52 failure.

**Fix direction:** wrap each `onRunFinished` call in its own try/catch (log +
continue), optionally with a deterministic order and/or a per-run backoff so a
permanently poisoned run cannot monopolize the pass.

---

## Problem 5 — Cancelling a run does not stick while its trigger condition holds

**Severity: medium (UX / operational control), design discussion needed.**

Dashboard cancel is a guarded status flip
(`apps/backend/src/dashboard/runs.controller.ts:390-409`, bulk `:419-441`).
Nothing records "a human cancelled this on purpose", so:

- **Rework path:** cancel frees the `runs_one_active` slot → the next
  drift-repair replay of the (unmarked) decision recreates the run
  (`4e013e29` appeared 16 s after `49f595cf` was cancelled). Fixed by
  Problem 1's idempotency.
- **Poll/release path:** the ticket still sits in the agent's
  `trigger_status`, so the next reconcile pass re-triggers the agent —
  `49779be1` (mimir) was created 13 s after `8a92fa06` was cancelled, via the
  dependency-release/poll trigger path (`libs/pipeline/src/pipeline.service.ts:131-144`).
  Not fixed by Problem 1: this is by-design pull semantics.

Today the only effective stop is pausing the whole workspace. Decide the
intended semantics: e.g. a cancelled run suppresses re-trigger of the same
(ticket, agent, trigger-status/deciding-run) tuple until the ticket changes
status or a human explicitly re-enables; or an explicit per-ticket "hold"
flag surfaced in the dashboard.

**Evidence:** run creation timestamps in `SXF-1174-timeline.txt`
(cancel→respawn deltas of 13–16 s on both paths).

---

## Problem 6 — Two uncoordinated launch paths coexist on one ticket

**Severity: medium, design discussion needed (overlaps Problem 5).**

The poller/release path fires agents whose `trigger_status` matches the
ticket's current status (`libs/pipeline/src/pipeline.service.ts:78-98`). The
orchestrator rework path fires whatever agent the (possibly hours-old) decision
names, with no check of the ticket's current status and explicitly bypassing
trigger statuses (`:515-545`). During the incident the ticket sat in `Review`:
mimir-reviewer ran legitimately by status while heimdall-qa was simultaneously
replayed into `QA`-work by a stale decision — two agents working the same
ticket with no arbitration ("heimdall triggers on Ready for QA" simply does not
apply on the rework path, by design).

**Fix direction:** staleness/consistency check before honoring a routing
decision — e.g. refuse (→ human task) when the ticket's current status is no
longer the one the decision was made in, or when another agent has an active
run on the ticket; alternatively serialize per-ticket ("one active run per
ticket", not per (ticket, agent)).

---

## Problem 7 — Agent finished without a schema-valid report (e033adef)

**Severity: medium, independent of the loop.**

Run `e033adef` (heimdall-qa) ran to completion — 570 s, 76 tool calls, $1.98 —
and then failed fail-closed with
`no schema-valid structured_output: expected object, received undefined`
(run error in `SXF-1174-dump.json`; also `SXF-1174-timeline.txt` "RUN ERRORS").
The agent produced real QA work (it even filed a hygiene human task `7695370d`
at 11:22:57) but never delivered the final structured report, so the entire run
was discarded.

**Fix direction (investigation first):** determine from `SXF-1174-events.md`
(events of `e033adef`, tail) whether the agent (a) never called
`complete_task`, (b) called it with an invalid payload and got no retry
guidance, or (c) the outbox/exit reconcile dropped a valid report. Then either
harden the executor's end-of-run handling (nudge/retry for the missing report)
or the callback validation UX. Note the tail-run pattern: the last two runs of
the incident were interrupted, but this one genuinely finished and still
yielded nothing.

**STATUS: FIXED (2026-07-28).** Investigation found none of (a)/(b)/(c) — the
real chain: the agent legitimately filed a **blocking** `request_human` at
11:23:37 and ended the session as instructed, but the per-run "one open task"
dedup guard (`libs/human-tasks/src/human-task.service.ts`) keyed on
`run_id + status='open'` only, so the non-blocking hygiene FYI filed 40 s
earlier (`7695370d`) swallowed it: no task row, no `awaiting_human` park, yet
an HTTP 200 response byte-identical to real success (the dropped
`created:false` flag). The run stayed `running`, the exit fail-closed it, and
the recorded error was a structural red herring (callback-wired runs never
carry `structured_output` — `--json-schema` is deliberately not passed).
Fixes: (1) dedup narrowed to per-run **per blocking-ness** + guarded re-park
on a blocking dedup hit + timeline `log` event for every dedup no-op (also in
the parallel `needs_human` dedup in `libs/runs/src/runs.service.ts`);
(2) callback response now carries `created` so the agent can tell a park from
a no-op; (3) the executor no longer emits the misleading
"no schema-valid structured_output" diagnostic for callback runs — `runs.error`
gets the truthful "exited without a complete_task or request_human callback";
(4) defense-in-depth in the worker's fail-closed branch: an open blocking task
at exit promotes the run to `awaiting_human` (guarded `WHERE status='running'`)
instead of failing it. Tests: `libs/human-tasks/src/human-task.service.spec.ts`,
`libs/runs/src/runs.service.spec.ts`, `libs/executors/src/claude-cli/claude-cli.executor.spec.ts`,
`test/integration/callback-human-dedup.spec.ts` (incident ordering),
`test/integration/callback-awaiting-human-noclobber.spec.ts` (promotion +
truthful diagnostic).

---

## Suggested order of work

1. **Problem 1** (with Problem 2 folded in) — kills the incident class.
   Integration tests: `test/integration/orchestrator-routing-loop.integration.spec.ts`.
2. **Problem 4** — one-line-ish isolation fix, immediately makes drift repair robust.
3. **Problem 3** — consumable human grant; test alongside Problem 1's suite.
4. **Problem 5 + 6 together** — one design conversation about stop semantics
   and per-ticket arbitration, then implement.
5. **Problem 7** — separate investigation into the executor/report path.
