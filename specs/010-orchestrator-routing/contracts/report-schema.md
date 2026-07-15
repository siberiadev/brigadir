# Contract: ReportSchema v1 — `routed` outcome

**File**: `packages/contracts/src/report.schema.ts` (extends existing v1; forward-compatible,
`schema_version` stays `1`). Normative source: `docs/architecture.md` §6.

## Change

Add a fourth outcome and its payload:

```ts
export const REPORT_OUTCOMES = ['success', 'failure', 'needs_human', 'routed'] as const;

export const ReportRoutingSchema = z
  .object({
    target_agent: z.string().max(200)
      .describe('Name of the enabled worker agent to hand the ticket back to.'),
    task: z.string().max(4000)
      .describe('Self-contained rework task in GitHub-flavored Markdown, framed as a fix of existing work.'),
  })
  .strict();

// on ReportSchema:
routing: ReportRoutingSchema.optional(),

// superRefine — add, alongside the existing needs_human rule:
if (report.outcome === 'routed' && report.routing === undefined) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routing'],
    message: 'routing is required when outcome is "routed"' });
}
```

## Rules

- `outcome==='routed'` REQUIRES `routing`; `routing` present on any other outcome is a `.strict()`
  violation only if provided without `routed` — mirror the `needs_human`⇒`human_task` treatment
  (FR-001).
- The schema does NOT enforce "orchestrator-only" — that is workspace state, checked in the pipeline
  (FR-002). A `routed` report from a non-orchestrator agent is schema-valid but pipeline-rejected as a
  failure.
- `routing.task` is scrubbed by the secret scrubber before persistence or Jira posting (FR-003).

## Contract tests (`report.schema.spec.ts`)

- `routed` + valid `routing` ⇒ parses.
- `routed` without `routing` ⇒ rejected (path `['routing']`).
- `success`/`failure`/`needs_human` unchanged (regression).
- `routing.target_agent` > 200 or `routing.task` > 4000 ⇒ rejected.
- unknown top-level key ⇒ rejected (`.strict()` preserved).
