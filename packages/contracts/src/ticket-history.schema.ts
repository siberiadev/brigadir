import { z } from 'zod';
import { RunStatusSchema } from './runs.schema';
import { HumanTaskKindSchema } from './human-queue.schema';

/**
 * Ticket history API contract (contracts/ticket-history-api.md) — the internal
 * ticket page: every run of one ticket in chronological order, with the causal
 * trigger references (`failing_run_id`/`deciding_run_id`) the client groups
 * into rework cycles, the failed checks that explain a QA fail, and the
 * orchestrator's routing verdict. `snake_case` bodies, money-as-string
 * (Postgres `numeric` round-trips as a string) — runs.schema conventions.
 *
 * Addressed by (workspace, jira_key): a ticket UUID is never exposed to the
 * client, and `jira_key` is unique only per workspace (the same key may exist
 * in several workspaces ingesting the same board).
 */

export const TicketHistoryAgentRefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    key: z.string(),
    role: z.string().nullable(),
    // Lets the client render triage runs distinctly without inferring from
    // trigger source alone.
    is_orchestrator: z.boolean(),
  })
  .strict();
export type TicketHistoryAgentRef = z.infer<typeof TicketHistoryAgentRefSchema>;

/**
 * Causal projection of `runs.trigger_event` — only the fields the history
 * graph needs. `source` is null for legacy rows written before the trigger
 * envelope existed.
 */
export const TicketHistoryTriggerSchema = z
  .object({
    source: z.string().nullable(),
    failing_run_id: z.string().nullable(),
    deciding_run_id: z.string().nullable(),
    target_agent: z.string().nullable(),
  })
  .strict();
export type TicketHistoryTrigger = z.infer<typeof TicketHistoryTriggerSchema>;

/** The orchestrator's routing verdict (`report.routing`), when present. */
export const TicketHistoryRoutingSchema = z
  .object({
    target_agent: z.string(),
    task: z.string(),
  })
  .strict();
export type TicketHistoryRouting = z.infer<typeof TicketHistoryRoutingSchema>;

/** Failed checklist rows only (`run_checks.status = 'fail'`) — the fail-reason chips. */
export const TicketHistoryFailedCheckSchema = z
  .object({
    name: z.string(),
    reason: z.string().nullable(),
  })
  .strict();
export type TicketHistoryFailedCheck = z.infer<typeof TicketHistoryFailedCheckSchema>;

export const TicketHistoryHumanTaskSchema = z
  .object({
    id: z.string(),
    kind: HumanTaskKindSchema,
    title: z.string(),
    status: z.enum(['open', 'resolved', 'dismissed']),
  })
  .strict();
export type TicketHistoryHumanTask = z.infer<typeof TicketHistoryHumanTaskSchema>;

export const TicketHistoryRunSchema = z
  .object({
    run_id: z.string(),
    agent: TicketHistoryAgentRefSchema,
    executor_type: z.string(),
    status: RunStatusSchema,
    outcome: z.string().nullable(),
    attempt: z.number().int(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    cost_usd: z.string().nullable(),
    trigger: TicketHistoryTriggerSchema,
    // `report.summary` — the human-readable "what happened" line (markdown).
    summary: z.string().nullable(),
    routing: TicketHistoryRoutingSchema.nullable(),
    failed_checks: z.array(TicketHistoryFailedCheckSchema),
    human_tasks: z.array(TicketHistoryHumanTaskSchema),
  })
  .strict();
export type TicketHistoryRun = z.infer<typeof TicketHistoryRunSchema>;

export const TicketHistoryTicketSchema = z
  .object({
    key: z.string(),
    summary: z.string().nullable(),
    jira_url: z.string(),
    last_seen_status: z.string().nullable(),
    priority_name: z.string().nullable(),
    blocked_state: z.string().nullable(),
  })
  .strict();
export type TicketHistoryTicket = z.infer<typeof TicketHistoryTicketSchema>;

export const TicketHistoryWorkspaceRefSchema = z
  .object({ id: z.string(), name: z.string() })
  .strict();

export const TicketHistoryAggregatesSchema = z
  .object({
    runs_total: z.number().int(),
    // Runs whose trigger source is `rework` — one per completed routing loop.
    rework_cycles: z.number().int(),
    total_cost_usd: z.string().nullable(),
    first_run_at: z.string().nullable(),
    last_finished_at: z.string().nullable(),
  })
  .strict();
export type TicketHistoryAggregates = z.infer<typeof TicketHistoryAggregatesSchema>;

// --- GET /api/workspaces/:id/tickets/:key/history ---

export const TicketHistoryResponseSchema = z
  .object({
    ticket: TicketHistoryTicketSchema,
    workspace: TicketHistoryWorkspaceRefSchema,
    // Chronological (created_at ASC) — the client derives cycles from order +
    // the trigger references; no pagination (a ticket has a handful of runs).
    runs: z.array(TicketHistoryRunSchema),
    aggregates: TicketHistoryAggregatesSchema,
  })
  .strict();
export type TicketHistoryResponse = z.infer<typeof TicketHistoryResponseSchema>;
