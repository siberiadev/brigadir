import { z } from 'zod';
import { makePaginatedResponseSchema } from './pagination.schema';

/**
 * Runs API contracts (feature 006, contracts/runs-api.md) — the runs table
 * (US3), the run/ticket card (US2), the lite cost figure, and the guarded
 * cancel + manual-trigger retry actions. Single typed source consumed by the
 * backend `runs.controller` and the Vue composables. `snake_case` bodies, the
 * shared path-qualified error envelope (dashboard.schema `ErrorBody`).
 *
 * Numeric money is serialized as a STRING (Postgres `numeric` round-trips as a
 * string via Drizzle) or null when absent — never a float.
 */

/** Run status vocabulary (architecture §3, unchanged). */
export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_human',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'superseded',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Check glyph states (run_checks.status → UI ✅/❌/⚠/⏭). */
export const RunCheckStatusSchema = z.enum(['pass', 'fail', 'warn', 'skip']);
export type RunCheckStatus = z.infer<typeof RunCheckStatusSchema>;

// --- shared nested shapes ---

export const RunAgentRefSchema = z
  .object({ id: z.string(), name: z.string(), key: z.string(), role: z.string().nullable() })
  .strict();

export const RunTicketRefSchema = z
  .object({
    key: z.string(),
    summary: z.string().nullable(),
    jira_url: z.string(),
  })
  .strict();

// --- GET /api/workspaces/:id/runs — runs table ---

export const RunListItemSchema = z
  .object({
    run_id: z.string(),
    agent: RunAgentRefSchema,
    // Null for ticketless workspace-setup runs (feature 011) — the UI renders
    // a static "Workspace setup" label instead of a Jira link.
    ticket: RunTicketRefSchema.nullable(),
    status: RunStatusSchema,
    attempt: z.number().int(),
    duration_ms: z.number().int().nullable(),
    // Anchor for the client-side live duration ticker on `running` rows —
    // `duration_ms` is computed at response time and goes stale between polls.
    started_at: z.string().nullable(),
    cost_usd: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunListResponseSchema = makePaginatedResponseSchema(RunListItemSchema);
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

// --- GET /api/workspaces/:id/runs/cost — lite cost figure ---

export const RunCostPeriodSchema = z.enum(['24h', '7d', '30d']);
export type RunCostPeriod = z.infer<typeof RunCostPeriodSchema>;

export const RunCostResponseSchema = z
  .object({
    period: RunCostPeriodSchema,
    total_cost_usd: z.string(),
    run_count: z.number().int(),
  })
  .strict();
export type RunCostResponse = z.infer<typeof RunCostResponseSchema>;

// --- GET /api/runs/:id — run/ticket card ---

export const RunCardCheckSchema = z
  .object({
    position: z.number().int(),
    name: z.string(),
    status: RunCheckStatusSchema,
    reason: z.string().nullable(),
  })
  .strict();
export type RunCardCheck = z.infer<typeof RunCardCheckSchema>;

export const RunCardEventSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    payload: z.unknown(),
    created_at: z.string(),
  })
  .strict();
export type RunCardEvent = z.infer<typeof RunCardEventSchema>;

export const RunCardHistoryItemSchema = z
  .object({
    run_id: z.string(),
    agent: z.string(),
    executor_type: z.string(),
    attempt: z.number().int(),
    duration_ms: z.number().int().nullable(),
    cost_usd: z.string().nullable(),
    outcome: z.string().nullable(),
    status: RunStatusSchema,
  })
  .strict();
export type RunCardHistoryItem = z.infer<typeof RunCardHistoryItemSchema>;

export const RunCardRunSchema = z
  .object({
    run_id: z.string(),
    // Owning workspace — lets the card deep-link back to the workspace's
    // runs list (the card route is addressed by run id alone).
    workspace_id: z.string(),
    status: RunStatusSchema,
    attempt: z.number().int(),
    executor_type: z.string(),
    agent: RunAgentRefSchema,
    duration_ms: z.number().int().nullable(),
    cost_usd: z.string().nullable(),
    usage: z.unknown().optional(),
    outcome: z.string().nullable(),
    external_ref: z.string().nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .strict();
export type RunCardRun = z.infer<typeof RunCardRunSchema>;

// Feature 019: one line per repo the run reported artifacts for — already
// normalized by the backend via normalizeReportArtifacts (flat legacy reports
// arrive as one element with repo=null); commits collapsed to a count for the
// card.
export const RunCardArtifactSchema = z
  .object({
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    pr_url: z.string().nullable(),
    commits_count: z.number().int().nullable(),
    files_changed: z.number().int().nullable(),
  })
  .strict();
export type RunCardArtifact = z.infer<typeof RunCardArtifactSchema>;

export const RunCardResponseSchema = z
  .object({
    run: RunCardRunSchema,
    // Null for ticketless workspace-setup runs (feature 011).
    ticket: RunTicketRefSchema.nullable(),
    checks: z.array(RunCardCheckSchema),
    // Feature 019: empty for runs without reported artifacts.
    artifacts: z.array(RunCardArtifactSchema),
    events: z.array(RunCardEventSchema),
    history: z.array(RunCardHistoryItemSchema),
  })
  .strict();
export type RunCardResponse = z.infer<typeof RunCardResponseSchema>;

// --- POST /api/runs/:id/cancel ---

export const RunCancelResponseSchema = z
  .object({
    ok: z.literal(true),
    cancelled: z.boolean(),
    reason: z.literal('not_running').optional(),
  })
  .strict();
export type RunCancelResponse = z.infer<typeof RunCancelResponseSchema>;

// --- POST /api/workspaces/:id/runs/cancel-all ---

/**
 * Bulk stop for a workspace: every `queued` or `running` run flips to
 * `cancelled` in one guarded UPDATE. `awaiting_human` is deliberately NOT
 * touched (CLAUDE.md rule #7 — a parked run is a human's decision, never
 * clobbered by a bulk action). `cancelled_count` = rows actually flipped
 * (0 is a valid, successful outcome).
 */
export const RunsCancelAllResponseSchema = z
  .object({
    ok: z.literal(true),
    cancelled_count: z.number().int(),
  })
  .strict();
export type RunsCancelAllResponse = z.infer<typeof RunsCancelAllResponseSchema>;

// --- POST /api/runs/:id/retry ---

export const RunRetryResponseSchema = z
  .object({
    ok: z.literal(true),
    run_id: z.string(),
    deduplicated: z.boolean(),
  })
  .strict();
export type RunRetryResponse = z.infer<typeof RunRetryResponseSchema>;
