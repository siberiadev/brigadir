# Contract: Handoff Section (ephemeral prompt block)

**Builder**: `buildHandoffSection(triggerEvent, db): Promise<string>` in `libs/pipeline`
(consumed by `apps/worker/src/run.processor.ts` and `apps/worker/src/claude-cli-run.processor.ts`
at `RunContext` build time). Never persisted; the agent's stored `instruction` is unchanged
(FR-012, SC-002). Replaces `instructionWithResumeAnswer` in the claude-cli processor (FR-014).

## Behavioral contract (FR-013)

- **Best-effort**: any missing source row degrades the section (omits that line), never throws,
  never fails the run.
- **Size-bounded**: each embedded field is truncated to a fixed budget so the total block cannot
  blow the prompt.
- **Read-only, own data**: reads only the system's own run history / human tasks (never Jira, never
  the repo).
- Returns `''` when the trigger carries no handoff source (non-handoff runs are unaffected).

## Block by handoff kind

### `triage` (orchestrator run)
```
## Handoff — triage
A worker run failed on this ticket. Decide how to proceed.

Failing run: <summary>
Failed/warning checks:
- <name>: <status> — <reason>
Artifacts: branch <branch>, PR <pr_url>

Available worker agents (route to one of these by name):
- <agent.name>: <agent.description>

Rework cycles used: <n> of <rework_max>

Decision protocol:
- Reply with outcome "routed" (target_agent + task) to send it back to a worker, OR
- outcome "needs_human" to escalate. Do not exceed the rework budget — the system enforces it.
```
Roster excludes the orchestrator itself and disabled agents. Protocol + roster arrive here, NOT in
the orchestrator's stored instruction (FR-012, AC US4-5).

### `rework` (worker run)
```
## Handoff — rework (fix of existing work)
This is a FIX of existing work, not a fresh implementation. Continue on the existing branch/PR.

Task from the orchestrator:
<task>

Original failure: <failing summary>
Failed checks:
- <name>: fail — <reason>
Continue on: branch <branch>, PR <pr_url>
```

### `human-resume` (resumed worker run)
```
## Handoff — human answer
You earlier asked for help. A human responded.

Question: <human_task.title>
<human_task.details>

Answer: <resolution>
```

## Tests (`handoff.spec.ts`, unit)

- Each kind renders its expected fields from seeded run/task rows.
- Missing `failing_run_id` row ⇒ section still returns, failure lines omitted, no throw.
- Oversized summary/task ⇒ truncated to the budget.
- Non-handoff source (`manual`/`poll`/`webhook`) ⇒ returns `''`.
- Roster excludes orchestrator + disabled agents; shows `description`.
- Integration: a rework run's assembled `RunContext.instruction` contains the task + failing context,
  while the agent's DB `instruction` row is byte-for-byte unchanged (SC-002).
