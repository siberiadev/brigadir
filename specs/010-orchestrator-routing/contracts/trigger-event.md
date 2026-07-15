# Contract: TriggerEventSchema — vocabulary fix + handoff fields

**File**: `packages/contracts/src/trigger-event.schema.ts`. Backward-compatible except the
`human_resume`→`human-resume` correction (a bug fix — the resume flow already writes `human-resume`).

## Change

```ts
export const TRIGGER_SOURCES = [
  'manual', 'webhook', 'poll',
  'human-resume',   // FR-023: was 'human_resume' (never written); resume.service.ts writes 'human-resume'
  'triage',         // orchestrator triage run created from a failed worker run
  'rework',         // worker run created from a valid routing decision
] as const;

export const MOCK_SCENARIOS = [
  'success', 'failure', 'needs_human', 'timeout', 'rate_limited', 'crash', 'delay',
  'routed',         // FR-024: mock orchestrator emits a routed report
] as const;

export const TriggerEventSchema = z
  .object({
    source: z.enum(TRIGGER_SOURCES).default('manual'),
    mock_scenario: z.enum(MOCK_SCENARIOS).default('success'),
    rate_limit_ttl_ms: z.number().int().positive().optional(),
    mock_delay_ms: z.number().int().positive().optional(),
    // handoff references (typed; schema still .passthrough()):
    failing_run_id: z.string().uuid().optional(),
    deciding_run_id: z.string().uuid().optional(),
    human_task_id: z.string().uuid().optional(),
    target_agent: z.string().max(200).optional(),
    task: z.string().max(4000).optional(),
    resolution: z.string().max(4000).nullable().optional(),  // already written by resume.service.ts
  })
  .passthrough();
```

## Handoff-source mapping

| `source` | written by | carries |
|----------|-----------|---------|
| `triage` | `PipelineService` (D4) | `failing_run_id` |
| `rework` | `PipelineService` (D6) | `failing_run_id`, `deciding_run_id`, `task`, `target_agent` |
| `human-resume` | `ResumeService` (D11) | `human_task_id`, `resolution` |

## Contract tests (`trigger-event.schema.spec.ts`)

- `source='human-resume'` parses; `source='human_resume'` rejected (the old bug value).
- `source='triage'|'rework'` parse.
- `mock_scenario='routed'` parses.
- a resumed mock run's stored trigger event (`{ source:'human-resume', resolution }`) validates —
  regression for the Edge Case crash.
- handoff id fields accept UUIDs and are optional.
