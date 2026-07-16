import { z } from 'zod';
import { AnswerOptionsSchema } from './answer-option.schema';

/**
 * runs.trigger_event JSONB payload (iteration 1).
 * Normative source: specs/001-pipeline-skeleton/data-model.md.
 *
 * The mock scenario rides here (research decision D3/D5) so the queue job
 * payload stays `{ runId }` only — identical to what real executors will use.
 * A real executor simply ignores `mock_scenario`.
 */

export const MOCK_SCENARIOS = [
  'success',
  'failure',
  'needs_human',
  'timeout',
  'rate_limited',
  'crash',
  // Holds the run in `running` for `mock_delay_ms` (default 500) then succeeds —
  // what the per-profile max_parallel_runs gate tests occupy slots with.
  'delay',
  // FR-024: the mock orchestrator emits a `routed` report (target read from the
  // trigger event) so integration tests can drive the full triage→route loop.
  'routed',
  // Feature 011 (D15): the mock orchestrator emits a `team` report (roster read
  // from the agent's behavior) so integration tests can drive the full
  // generate→propose→apply→review loop without a live agent.
  'team',
  // Feature 011 (D15): first submits a proposal with a bogus status (must be
  // rejected 422 with zero agents created), then exits without a valid report —
  // exercising the repair-loop rejection and the fail-closed path.
  'team_invalid',
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/**
 * Trigger-source vocabulary (feature 010, FR-023/D8 + the answer-triage delta).
 * - `human-resume` fixes the pre-existing `human_resume` bug — `resume.service.ts`
 *   has always WRITTEN `human-resume`, which the old enum rejected on validation.
 * - `triage`: orchestrator run created from a terminally-failed worker run.
 * - `rework`: worker run created from a valid routing decision.
 * - `answer-triage`: orchestrator run created by a human resolving a blocking
 *   task with the orchestrator as the resume target — carries the Q&A
 *   (`human_task_id` + `resolution`) alongside the failing-run reference; the
 *   rework run it decides is exempt from the cycle budget (a human answered).
 * - `workspace-setup` (feature 011, D1): ticketless orchestrator run started by
 *   the explicit "Generate agents" action; carries `human_task_id`/`resolution`
 *   when resumed from a parked setup question. Skips BullMQ dedup like the
 *   continuation sources — `runs_one_active_setup` is the authority.
 */
export const TRIGGER_SOURCES = [
  'manual',
  'webhook',
  'poll',
  'human-resume',
  'triage',
  'rework',
  'answer-triage',
  'workspace-setup',
] as const;

export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const TriggerEventSchema = z
  .object({
    source: z.enum(TRIGGER_SOURCES).default('manual'),
    mock_scenario: z.enum(MOCK_SCENARIOS).default('success'),
    rate_limit_ttl_ms: z.number().int().positive().optional(),
    mock_delay_ms: z.number().int().positive().optional(),
    // feature 013: answer options for the mock `needs_human` scenario — rides
    // here like mock_delay_ms/target_agent so integration tests can drive the
    // options loop without live agents. Real executors ignore it.
    mock_options: AnswerOptionsSchema.optional(),
    // Handoff references (feature 010, D7/D8) — typed for handoff assembly and the
    // mock executor; the schema still .passthrough()es for forward compatibility.
    failing_run_id: z.string().uuid().optional(),
    deciding_run_id: z.string().uuid().optional(),
    human_task_id: z.string().uuid().optional(),
    target_agent: z.string().max(200).optional(),
    task: z.string().max(4000).optional(),
    // Operator answer, already written by resume.service.ts on resumed runs.
    resolution: z.string().max(4000).nullable().optional(),
  })
  .passthrough();

export type TriggerEvent = z.infer<typeof TriggerEventSchema>;
