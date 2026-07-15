import { z } from 'zod';

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
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/**
 * Six-value trigger-source vocabulary (feature 010, FR-023/D8).
 * - `human-resume` fixes the pre-existing `human_resume` bug — `resume.service.ts`
 *   has always WRITTEN `human-resume`, which the old enum rejected on validation.
 * - `triage`: orchestrator run created from a terminally-failed worker run.
 * - `rework`: worker run created from a valid routing decision.
 */
export const TRIGGER_SOURCES = [
  'manual',
  'webhook',
  'poll',
  'human-resume',
  'triage',
  'rework',
] as const;

export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const TriggerEventSchema = z
  .object({
    source: z.enum(TRIGGER_SOURCES).default('manual'),
    mock_scenario: z.enum(MOCK_SCENARIOS).default('success'),
    rate_limit_ttl_ms: z.number().int().positive().optional(),
    mock_delay_ms: z.number().int().positive().optional(),
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
