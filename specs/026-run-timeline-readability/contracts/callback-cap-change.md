# Contract change: `report_progress.message` cap 500 → 4000

File: `packages/contracts/src/callback-tools.schema.ts`

```diff
 export const ReportProgressSchema = z
   .object({
     percent: z.number().min(0).max(100).optional(),
     stage: z.string(),
-    message: z.string().max(500),
+    message: z.string().max(4000),
   })
   .strict();
```

## Behavior

- `message` length 0–4000 → accepted (HTTP 200; a `progress` `run_event` is written with the full, scrubbed message).
- `message` length > 4000 → validation failure (HTTP 422, run untouched) — same failure path as today, higher bound.
- Aligns with `RequestHumanSchema.details.max(4000)` (the established human-text bound).

## Propagation

- The schema backs the callback HTTP validation (`CallbackService.progress`) and the MCP tool definition (`packages/mcp-server`). Raising the zod `.max` propagates to the advertised tool input bound automatically — no mcp-server code change.
- Any test asserting the old 500 bound (`callback-tools.schema.spec.ts`, and mcp-server tests if present) MUST be updated to assert 4000.

## Compatibility

- Backward compatible: every previously-valid message stays valid; the accepted range only widens.
- No persisted-data migration.
