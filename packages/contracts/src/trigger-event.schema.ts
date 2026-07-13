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
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const TRIGGER_SOURCES = ['manual', 'webhook', 'poll', 'human_resume'] as const;

export const TriggerEventSchema = z
  .object({
    source: z.enum(TRIGGER_SOURCES).default('manual'),
    mock_scenario: z.enum(MOCK_SCENARIOS).default('success'),
    rate_limit_ttl_ms: z.number().int().positive().optional(),
    mock_delay_ms: z.number().int().positive().optional(),
  })
  .passthrough();

export type TriggerEvent = z.infer<typeof TriggerEventSchema>;
