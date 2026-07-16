# Contract: Report `team` outcome

Extends `packages/contracts/src/report.schema.ts` (v1, additive — no version bump; forward-compatible
per Constitution VI contract rules). Mirrors the `routed` precedent from feature 010.

## Schema delta

```ts
export const REPORT_OUTCOMES = ['success', 'failure', 'needs_human', 'routed', 'team'] as const;

export const TeamAgentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  instruction: z.string().min(1).max(8000),
  trigger_status: z.string().min(1).max(100),
  status_running: z.string().min(1).max(100).optional(),
  status_success: z.string().min(1).max(100),
  status_failure: z.string().min(1).max(100),
  executor: z.string().min(1).max(200), // executor PROFILE NAME — resolved & validated server-side
}).strict();

export const ReportTeamSchema = z.object({
  agents: z.array(TeamAgentSchema).min(1).max(20),
}).strict();

// ReportSchema: + team: ReportTeamSchema.optional()
// superRefine: outcome === 'team'  ⇒ team required   (mirrors needs_human ⇒ human_task)
//              outcome !== 'team'  ⇒ team forbidden  (.strict() + explicit refine message)
```

## Acceptance semantics (accept-path, D9/D10)

1. Zod validation — failure → `422` (unchanged behavior).
2. **Business validation** (only for `outcome==='team'`, only for a run whose
   `trigger_event.source === 'workspace-setup'` on an orchestrator agent — otherwise the
   outcome is recast as a failure, FR-014):
   - names unique within proposal AND against all existing workspace agents (incl. `brigadir`);
   - every `trigger_status` / `status_running` / `status_success` / `status_failure` present on
     the live board (reuse `lintAgent` `status_absent` + `StatusesService.get({refresh:true})`);
   - `executor` resolves by name to an existing **enabled** executor profile;
   - `duplicate_trigger` lint across proposal ∪ existing enabled agents.

   Any violation → **`422` with the path-qualified issue list** returned through the
   `complete_task` tool result. The run STAYS `running` — the agent may correct and re-submit.
   This is the FR-017 amendment: the repair loop replaces insta-fail.
3. **Atomic apply** (same transaction as validation, closing the validate/apply race):
   insert all agents (`enabled=true`) via the same insert shape as `AgentsController.create`
   (`toInsertValues` equivalent: `status_ids` into `behavior`, workspace default repository),
   insert the review human task (`kind='review'`, `blocking=false`, `ticket_id=NULL`,
   `run_id=<setup run>`, title `Team assembled — review the workspace`, details = proposal
   summary), finalize the run `succeeded` (guarded, as today).
4. Repeated `complete` after success → `409` (unchanged idempotent-completion rule).

## Scrubbing

`scrubReport` (`libs/callback/src/callback.service.ts:28-51`) extends to
`team.agents[].description` and `team.agents[].instruction`. Identifier fields
(`name`, statuses, `executor`) stay unscrubbed — same rationale as `routing.target_agent`.

## Finalize mapping

`RunsService.finalizeWithReport`: `team` (accepted) → `succeeded`, joining
`success | routed → succeeded` (`libs/runs/src/runs.service.ts:76-81`).

## Contract tests

- `team` without payload / empty agents / >20 agents / extra keys → schema reject.
- `team` payload on `outcome:'success'` → reject (forbidden refine).
- JSON-Schema round-trip (existing `zodToJsonSchema` suite) includes `team`.
- Accept-path: invalid proposal → 422 issue list, run still `running`; valid → agents+task+succeeded atomically; duplicate name vs existing agent → 422 (not 500 — closes the linter gap).
