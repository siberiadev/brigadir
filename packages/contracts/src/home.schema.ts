import { z } from 'zod';
import {
  RunAgentRefSchema,
  RunCostPeriodSchema,
  RunStatusSchema,
  RunTicketRefSchema,
} from './runs.schema';

/**
 * Home dashboard API contracts (feature 017) — the aggregate summary powering
 * the stat tiles + spend block, the workspace-cards read model, and the bounded
 * cross-workspace runs listing. Single typed source consumed by the backend
 * `home.controller` / `runs.controller` and the Vue composables. `snake_case`
 * bodies; money serialized as a STRING (numeric round-trip), never a float.
 *
 * The dashboard lists are sanctioned whole-list/top-N consumers: responses are
 * NOT paginated envelopes (`{ items, total }` / `{ items }` only).
 */

// --- GET /api/home/summary ---

export const HomeSpendEntrySchema = z
  .object({
    // `coalesce(sum(cost_usd), 0)::text` — zero spend is the string "0"-form,
    // never null. Window column is `created_at`, matching the per-workspace
    // cost endpoint so the platform figure equals the sum of workspace figures.
    total_cost_usd: z.string(),
    run_count: z.number().int(),
  })
  .strict();
export type HomeSpendEntry = z.infer<typeof HomeSpendEntrySchema>;

export const HomeSummaryResponseSchema = z
  .object({
    running: z.number().int(),
    queued: z.number().int(),
    // Runs that FINISHED failed/timed_out within the last 24h (`finished_at`
    // window) — split so the tile can render "N failed · M timed out".
    attention_24h: z
      .object({ failed: z.number().int(), timed_out: z.number().int() })
      .strict(),
    human_open: z.number().int(),
    // All three periods in one response: the UI period switcher is pure
    // client-side state, no refetch.
    spend: z
      .object({
        '24h': HomeSpendEntrySchema,
        '7d': HomeSpendEntrySchema,
        '30d': HomeSpendEntrySchema,
      })
      .strict(),
  })
  .strict();
export type HomeSummaryResponse = z.infer<typeof HomeSummaryResponseSchema>;

// --- GET /api/runs — bounded cross-workspace runs listing ---

export const GLOBAL_RUNS_DEFAULT_LIMIT = 10;
export const GLOBAL_RUNS_MAX_LIMIT = 50;

/**
 * `status` is REQUIRED (CSV of the run-status vocabulary) and `limit` is always
 * bounded — an unbounded "all runs everywhere" query is impossible by contract.
 * An out-of-range/garbage `limit` falls back to the default (the pagination
 * convention: `.catch()` tolerance, never a 500).
 */
export const GlobalRunsStatusFilterSchema = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(RunStatusSchema).min(1));

export const GlobalRunsQuerySchema = z
  .object({
    status: GlobalRunsStatusFilterSchema,
    // Optional `finished_at >= now() - period` window (needs-attention: '24h').
    finished_within: RunCostPeriodSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(GLOBAL_RUNS_MAX_LIMIT)
      .catch(GLOBAL_RUNS_DEFAULT_LIMIT)
      .default(GLOBAL_RUNS_DEFAULT_LIMIT),
  })
  .strict();
export type GlobalRunsQuery = z.infer<typeof GlobalRunsQuerySchema>;

export const GlobalRunWorkspaceRefSchema = z
  .object({ id: z.string(), name: z.string() })
  .strict();

export const GlobalRunListItemSchema = z
  .object({
    run_id: z.string(),
    agent: RunAgentRefSchema,
    // Null for ticketless workspace-setup runs (feature 011).
    ticket: RunTicketRefSchema.nullable(),
    // The cross-workspace dimension vs. the workspace-scoped RunListItem.
    workspace: GlobalRunWorkspaceRefSchema,
    status: RunStatusSchema,
    attempt: z.number().int(),
    duration_ms: z.number().int().nullable(),
    started_at: z.string().nullable(),
    // Needs-attention rows show WHEN it finished (not part of RunListItem).
    finished_at: z.string().nullable(),
    cost_usd: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type GlobalRunListItem = z.infer<typeof GlobalRunListItemSchema>;

export const GlobalRunsResponseSchema = z
  .object({
    items: z.array(GlobalRunListItemSchema),
    // FULL count matching the filter (not items.length) — powers "showing
    // N of M" overflow notes on the dashboard lists.
    total: z.number().int(),
  })
  .strict();
export type GlobalRunsResponse = z.infer<typeof GlobalRunsResponseSchema>;

// --- GET /api/home/workspaces — workspace cards read model ---

export const HomeWorkspaceLastRunSchema = z
  .object({
    run_id: z.string(),
    status: RunStatusSchema,
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type HomeWorkspaceLastRun = z.infer<typeof HomeWorkspaceLastRunSchema>;

export const HomeWorkspaceItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    project_key: z.string(),
    board_type: z.string().nullable(),
    // `settings.enabled !== false` — false renders the card paused.
    enabled: z.boolean(),
    agent_count: z.number().int(),
    // Newest run by created_at; null ⇒ "no runs yet".
    last_run: HomeWorkspaceLastRunSchema.nullable(),
    // failed+timed_out runs with finished_at in the last 24h.
    attention_24h: z.number().int(),
  })
  .strict();
export type HomeWorkspaceItem = z.infer<typeof HomeWorkspaceItemSchema>;

export const HomeWorkspacesResponseSchema = z
  .object({ items: z.array(HomeWorkspaceItemSchema) })
  .strict();
export type HomeWorkspacesResponse = z.infer<typeof HomeWorkspacesResponseSchema>;
