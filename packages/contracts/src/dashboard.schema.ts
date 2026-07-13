import { z } from 'zod';
import { WorkspaceRepositorySchema } from './jira.types';

/**
 * Dashboard REST API request/response contracts (feature 005,
 * contracts/dashboard-api.md). Single typed source consumed by both the backend
 * authority (`apps/backend/src/dashboard`) and the `apps/web` client.
 *
 * Security invariant: NO response schema here serializes `jira_credentials` or
 * `api_token`. Credentials are write-only over the wire; the list/detail views
 * expose only a derived `credential_status` badge (FR-021 / SC-009).
 */

// --- shared value types ---

export const BoardTypeSchema = z.enum(['kanban', 'scrum']);

/** Badge state derived from `jira_credential_expires_at` (FR-021). */
export const CredentialStatusSchema = z.enum(['ok', 'warn_30', 'warn_7', 'expired']);
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

/** Board status id+name binding carried on an agent (FR-010, `behavior.status_ids`). */
export const AgentStatusIdsSchema = z
  .object({
    trigger: z.string().optional(),
    running: z.string().optional(),
    success: z.string().optional(),
    failure: z.string().optional(),
  })
  .strict();
export type AgentStatusIds = z.infer<typeof AgentStatusIdsSchema>;

// --- Workspace requests ---

/** POST /api/workspaces/verify — pre-persist live validation (no row written). */
export const WorkspaceVerifyRequestSchema = z
  .object({
    jira_site_url: z.string().url(),
    jira_email: z.string().min(1),
    jira_api_token: z.string().min(1),
    // board id OR a board URL — the server extracts the id (FR-006).
    board: z.string().min(1),
  })
  .strict();
export type WorkspaceVerifyRequest = z.infer<typeof WorkspaceVerifyRequestSchema>;

/** POST /api/workspaces — create (server re-runs Verify before writing). */
export const WorkspaceCreateRequestSchema = z
  .object({
    name: z.string().min(1),
    jira_site_url: z.string().url(),
    jira_email: z.string().min(1),
    jira_api_token: z.string().min(1),
    // User-entered expiry (Atlassian exposes no token-expiry API); default +1y.
    expires_at: z.string().datetime(),
    board: z.string().min(1),
    repositories: z.array(WorkspaceRepositorySchema).default([]),
  })
  .strict();
export type WorkspaceCreateRequest = z.infer<typeof WorkspaceCreateRequestSchema>;

/** PUT /api/workspaces/:id/jira-connection — token rotation (re-verified live). */
export const WorkspaceRotateRequestSchema = z
  .object({
    jira_email: z.string().min(1),
    jira_api_token: z.string().min(1),
    expires_at: z.string().datetime(),
  })
  .strict();
export type WorkspaceRotateRequest = z.infer<typeof WorkspaceRotateRequestSchema>;

/** PUT /api/workspaces/:id/settings — all optional; takes effect next pass. */
export const WorkspaceSettingsRequestSchema = z
  .object({
    scope_jql: z.string().min(1).optional(),
    branch_prefix: z.string().min(1).optional(),
    repositories: z.array(WorkspaceRepositorySchema).optional(),
    // Feature 006 (US5): the enabled/pause flag. Absent ⇒ unchanged; `false`
    // pauses the workspace in the multi-workspace reconcile loop (settings jsonb;
    // no DDL — mirrors WorkspaceSettings.enabled).
    enabled: z.boolean().optional(),
  })
  .strict();
export type WorkspaceSettingsRequest = z.infer<typeof WorkspaceSettingsRequestSchema>;

// --- Workspace responses (credentials NEVER serialized) ---

export const WorkspaceResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    jira_site_url: z.string(),
    project_key: z.string(),
    board_id: z.number().int().nullable(),
    board_type: BoardTypeSchema.nullable(),
    expires_at: z.string().nullable(),
    credential_status: CredentialStatusSchema,
    repositories: z.array(WorkspaceRepositorySchema),
    // Feature 008 (FR-014): the single additive, non-breaking extension. The
    // Settings tab's read-only blocks render these and its edit modals SEED from
    // them (killing the `feat`/`""` hard-coded-default footgun). All three are
    // nullable (legacy rows created before prefix/scope were persisted → null).
    // `bot_email` surfaces ONLY the decoded credential `.email`; `api_token` is
    // NEVER a key of this shape (Principle V).
    bot_email: z.string().nullable(),
    branch_prefix: z.string().nullable(),
    scope_jql: z.string().nullable(),
    // Feature 006 (US5): the enabled/pause flag surfaced so the settings toggle
    // reflects persisted state. Absent settings ⇒ treated as enabled (true).
    enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;

export const VerifyResponseSchema = z
  .object({
    bot_display_name: z.string(),
    project_key: z.string(),
    board_id: z.number().int(),
    board_type: BoardTypeSchema,
  })
  .strict();
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const BoardStatusResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  statusCategory: z.enum(['new', 'indeterminate', 'done']),
});
export const StatusesResponseSchema = z
  .object({ statuses: z.array(BoardStatusResponseSchema) })
  .strict();
export type StatusesResponse = z.infer<typeof StatusesResponseSchema>;

// --- Agent requests/responses ---

export const AgentBehaviorRequestSchema = z
  .object({
    branch_prefix: z.string().nullable().optional(),
    // Platform-scoped executors (2026-07-13): the run's repository is an AGENT
    // choice, persisted here — empty/absent means the workspace default repo.
    repository: z.string().nullable().optional(),
    allowed_tools: z.array(z.string()).optional(),
    required_checks: z.array(z.string()).optional(),
    use_callback_channel: z.boolean().optional(),
    status_ids: AgentStatusIdsSchema.optional(),
  })
  .passthrough();

export const AgentWriteRequestSchema = z
  .object({
    workspace_id: z.string().min(1),
    name: z.string().min(1),
    instruction: z.string().min(1),
    executor_id: z.string().min(1),
    // NO model field: the executor PROFILE's model is the single source of
    // truth (named runner profiles, 2026-07-14). A legacy `behavior.model`
    // still parses (behavior is passthrough) but the runtime ignores it.
    trigger_status: z.string().min(1),
    trigger_jql: z.string().nullable().optional(),
    status_running: z.string().nullable().optional(),
    status_success: z.string().min(1),
    status_failure: z.string().min(1),
    status_ids: AgentStatusIdsSchema.optional(),
    timeout_minutes: z.number().int().positive().default(45),
    max_budget_usd: z.number().positive().nullable().optional(),
    max_attempts: z.number().int().min(1).default(2),
    behavior: AgentBehaviorRequestSchema.default({}),
  })
  .strict();
export type AgentWriteRequest = z.infer<typeof AgentWriteRequestSchema>;

export const AgentResponseSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    executor_id: z.string(),
    name: z.string(),
    instruction: z.string(),
    trigger_status: z.string().nullable(),
    trigger_jql: z.string().nullable(),
    status_running: z.string().nullable(),
    status_success: z.string(),
    status_failure: z.string(),
    behavior: z.record(z.string(), z.unknown()),
    timeout_minutes: z.number(),
    max_budget_usd: z.number().nullable(),
    max_attempts: z.number(),
    enabled: z.boolean(),
  })
  .strict();
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/** POST /api/agents/:id/test-run */
export const TestRunRequestSchema = z.object({ ticket_key: z.string().min(1) }).strict();
export type TestRunRequest = z.infer<typeof TestRunRequestSchema>;

// --- shared, path-qualified error shape (FR-013 / SC-009) ---

export const ErrorIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
  value: z.unknown().optional(),
  level: z.enum(['error', 'warning']),
});
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(ErrorIssueSchema).optional(),
    warnings: z.array(ErrorIssueSchema).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
