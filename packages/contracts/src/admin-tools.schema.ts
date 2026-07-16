import { z } from 'zod';
import { TeamAgentSchema } from './report.schema';
import {
  BoardTypeSchema,
  WorkspaceResponseSchema,
  CreateTeamResponseSchema,
} from './dashboard.schema';

/**
 * Admin MCP tool schemas (feature 012, `packages/admin-mcp` → `brigadir-admin`).
 * Normative source: specs/012-admin-mcp/contracts/admin-tools.md.
 *
 * One zod module, TWO bindings per tool: `inputSchema` AND `outputSchema` (MCP
 * structured output). Converted to JSON Schema with
 * `z.toJSONSchema(schema, { target: 'draft-7' })` — the same draft-07 wire dialect
 * `packages/mcp-server` pins (iteration 16). Every field carries `.describe(...)`
 * with bounds/examples and a note on what the SERVER validates; all objects are
 * `.strict()`.
 *
 * Security invariant (Constitution Principle V): NO secret is a member of any
 * INPUT schema — the `brigadir-admin` server reads `BRIGADIR_DASHBOARD_TOKEN` /
 * `BRIGADIR_JIRA_EMAIL` / `BRIGADIR_JIRA_API_TOKEN` from its own env and injects
 * them (header + workspace-create body). The model never sees or passes them.
 *
 * Cross-field rules (e.g. a team agent's statuses must exist on the live board,
 * names must be unique, triggers must not collide) do NOT survive JSON Schema
 * conversion — they are documented in `.describe(...)` text and enforced by the
 * backend, which answers 422 with path-qualified issues the model repairs from.
 */

// --- shared, projected value objects (the handler projects backend rows into
// these strict shapes so `structuredContent` conforms to the declared output) ---

const uuid = () =>
  z
    .string()
    .uuid()
    .describe('Workspace UUID as returned by list_workspaces / create_workspace.');

export const WorkspaceSummarySchema = z
  .object({
    id: z.string().describe('Workspace UUID.'),
    name: z.string().describe('Human-readable workspace name.'),
    project_key: z.string().describe('Jira project key, e.g. "BRIG".'),
    board_type: BoardTypeSchema.nullable().describe('"kanban" | "scrum" | null (not yet resolved).'),
    enabled: z
      .boolean()
      .describe('Whether the workspace is running (false = paused; new workspaces start paused).'),
  })
  .strict();

export const BoardStatusSummarySchema = z
  .object({
    name: z.string().describe('Exact workflow status name — use these VERBATIM in a team proposal.'),
    category: z
      .enum(['new', 'indeterminate', 'done'])
      .describe('Jira status category the status maps to.'),
  })
  .strict();

export const ExecutorSummarySchema = z
  .object({
    name: z.string().describe('Executor PROFILE NAME — agents reference a profile by this name.'),
    type: z.string().describe('Runner transport type, e.g. "mock" | "claude_cli".'),
    model: z.string().nullable().describe('Model id when the profile pins one (else null, e.g. mock).'),
    enabled: z.boolean().describe('Whether the profile is enabled (a disabled profile is rejected).'),
  })
  .strict();

export const AgentSummarySchema = z
  .object({
    id: z.string().describe('Agent UUID — the true identity; use it for update_agent.'),
    name: z.string().describe('Persona display name (feature 014; may repeat within a workspace).'),
    key: z.string().describe('Readable, workspace-unique handle (routing/URLs/logs). System-generated, immutable.'),
    role: z.string().nullable().describe('The agent\'s function ("Developer"/"QA"/…; orchestrator "teamlead").'),
    description: z.string().nullable().describe('One roster line shown to the orchestrator.'),
    is_orchestrator: z
      .boolean()
      .describe('True for the seeded "brigadir" orchestrator — it cannot be duplicated or deleted.'),
    executor_id: z.string().describe('Executor profile id bound to this agent.'),
    trigger_status: z.string().nullable().describe('Board status that starts this agent.'),
    status_success: z.string().describe('Status the agent moves the ticket to on success.'),
    status_failure: z.string().describe('Status the agent moves the ticket to on failure.'),
    enabled: z.boolean().describe('Whether the agent participates in the pipeline.'),
  })
  .strict();

// --- agent write input (create_agent / update_agent) — maps to AgentWriteRequest ---

const AdminAgentWriteFields = {
  workspace_id: uuid(),
  name: z
    .string()
    .min(1)
    .max(200)
    .describe('Persona display name (feature 014; may repeat). The system derives the key — never send one.'),
  role: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe('The agent\'s function: "Developer", "QA", "Reviewer", "Planner", ….'),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe('Optional roster line shown to the orchestrator in handoffs.'),
  instruction: z
    .string()
    .min(1)
    .describe('Self-contained role prompt in GitHub-flavored Markdown.'),
  executor_id: z
    .string()
    .min(1)
    .describe('Executor profile id (resolve a NAME from list_executors to its id first).'),
  trigger_status: z
    .string()
    .min(1)
    .describe('Board workflow status that starts this agent — must exist on the board (get_board_statuses).'),
  trigger_jql: z.string().nullable().optional().describe('Optional extra JQL filter; usually null.'),
  status_running: z
    .string()
    .nullable()
    .optional()
    .describe('Optional status set while the agent runs.'),
  status_success: z.string().min(1).describe('Status set on success — must exist on the board.'),
  status_failure: z.string().min(1).describe('Status set on failure — must exist on the board.'),
  timeout_minutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Per-run wall-clock cap in minutes (default 45).'),
  max_budget_usd: z
    .number()
    .positive()
    .nullable()
    .optional()
    .describe('Optional per-run USD budget cap (null = unlimited).'),
  max_attempts: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Max attempts before the run fails (default 2).'),
  enabled: z
    .boolean()
    .optional()
    .describe('Whether the agent is enabled (default true on create).'),
};

export const AdminCreateAgentInputSchema = z.object(AdminAgentWriteFields).strict();

export const AdminUpdateAgentInputSchema = z
  .object({
    agent_id: z.string().uuid().describe('UUID of the agent to update (from list_agents).'),
    ...AdminAgentWriteFields,
  })
  .strict();

export const AgentWriteResultSchema = z
  .object({
    agent_id: z.string().describe('UUID of the created/updated agent.'),
    name: z.string().describe('Persona display name.'),
    key: z.string().describe('System-generated readable handle (feature 014).'),
    is_orchestrator: z.boolean().describe('True only for the seeded orchestrator.'),
  })
  .strict();

// --- create_workspace ---

/** Repositories accepted by create_workspace; `default_branch` defaults to "main". */
export const AdminRepositoryInputSchema = z
  .object({
    name: z.string().min(1).describe('Short repo label used to reference it from an agent.'),
    git_url: z.string().min(1).describe('Clone URL (https or ssh).'),
    default_branch: z
      .string()
      .min(1)
      .optional()
      .describe('Base branch the agent branches from (default "main").'),
  })
  .strict();

export const CreateWorkspaceInputSchema = z
  .object({
    name: z.string().min(1).max(200).describe('Human-readable workspace name.'),
    jira_site_url: z
      .string()
      .url()
      .describe('Jira Cloud site base URL, e.g. "https://acme.atlassian.net".'),
    board: z
      .string()
      .min(1)
      .describe('Jira board id (e.g. "42") OR a board URL — the server extracts the id.'),
    expires_at: z
      .string()
      .datetime()
      .describe(
        'ISO 8601 expiry of the JIRA bot token (drives the credential badge), e.g. "2027-07-12T00:00:00.000Z". ' +
          'This is the Jira token expiry, NOT the admin bearer.',
      ),
    repositories: z
      .array(AdminRepositoryInputSchema)
      .max(50)
      .optional()
      .describe('Optional repositories the workspace agents work in.'),
  })
  .strict();

export const CreateWorkspaceResultSchema = z
  .object({
    workspace_id: z.string().describe('UUID of the created workspace.'),
    project_key: z.string().describe('Jira project key resolved from the board.'),
    board_type: BoardTypeSchema.nullable().describe('"kanban" | "scrum".'),
    enabled: z
      .literal(false)
      .describe('ALWAYS false — the backend creates workspaces PAUSED (feature 011); Start stays with the human.'),
  })
  .strict();

// --- generate_agents ---

export const GenerateAgentsInputSchema = z.object({ workspace_id: uuid() }).strict();
export const GenerateAgentsResultSchema = z
  .object({
    run_id: z
      .string()
      .describe(
        'UUID of the started setup run. 409 codes if unavailable: worker_agents_exist ' +
          '(a team already exists), no_orchestrator (no enabled orchestrator), setup_run_active ' +
          '(a setup run is already running).',
      ),
  })
  .strict();

// --- create_team ---

export const CreateTeamInputSchema = z
  .object({
    workspace_id: uuid(),
    agents: z
      .array(TeamAgentSchema)
      .min(1)
      .max(20)
      .describe(
        'The roster (1..20). Each agent names board statuses (from get_board_statuses) and an ' +
          'executor PROFILE NAME (from list_executors). The server validates the whole roster ' +
          'atomically: unknown status, unknown/disabled profile, duplicate or orchestrator name, ' +
          'or a trigger-status collision ⇒ 422 with path-qualified issues and ZERO agents created.',
      ),
  })
  .strict();

// --- read tool inputs ---

export const EmptyInputSchema = z.object({}).strict();
export const WorkspaceIdInputSchema = z.object({ workspace_id: uuid() }).strict();

// --- read tool outputs ---

export const ListWorkspacesResultSchema = z
  .object({ items: z.array(WorkspaceSummarySchema).describe('All workspaces (a single page of ≤100).') })
  .strict();
export const BoardStatusesResultSchema = z
  .object({ statuses: z.array(BoardStatusSummarySchema).describe('Live board statuses.') })
  .strict();
export const ListExecutorsResultSchema = z
  .object({ items: z.array(ExecutorSummarySchema).describe('Platform executor profiles.') })
  .strict();
export const ListAgentsResultSchema = z
  .object({ items: z.array(AgentSummarySchema).describe('The workspace roster incl. the orchestrator.') })
  .strict();

/**
 * The tool registry: each entry declares `input` and `output` zod schemas plus a
 * human description. `main.ts` converts both to JSON Schema; `tools.ts` maps each
 * to one dashboard HTTP call and projects the response into `output`.
 */
export const AdminTools = {
  list_workspaces: {
    description:
      'List all workspaces (id, name, project_key, board_type, enabled). Read-only recon. ' +
      'New workspaces are paused (enabled=false).',
    input: EmptyInputSchema,
    output: ListWorkspacesResultSchema,
  },
  get_workspace: {
    description: 'Get one workspace by id, including its enabled (paused) state. Read-only.',
    input: WorkspaceIdInputSchema,
    output: WorkspaceResponseSchema,
  },
  get_board_statuses: {
    description:
      'Get the workspace board\'s live workflow statuses (name + category). This is the ' +
      'ONLY sanctioned source of status names for a team proposal — use them verbatim. Read-only.',
    input: WorkspaceIdInputSchema,
    output: BoardStatusesResultSchema,
  },
  list_executors: {
    description:
      'List platform executor profiles (name, type, model, enabled). Agents reference a profile ' +
      'by NAME (create_team) or by id (create_agent). Read-only.',
    input: EmptyInputSchema,
    output: ListExecutorsResultSchema,
  },
  list_agents: {
    description: 'List a workspace\'s agents incl. is_orchestrator. Read-only.',
    input: WorkspaceIdInputSchema,
    output: ListAgentsResultSchema,
  },
  create_workspace: {
    description:
      'Create a workspace from a Jira board (the server injects the Jira bot email/token from ' +
      'its env — never pass them). The workspace is created PAUSED (enabled=false): a human ' +
      'reviews the team and presses Start in the dashboard. There is deliberately no start tool.',
    input: CreateWorkspaceInputSchema,
    output: CreateWorkspaceResultSchema,
  },
  generate_agents: {
    description:
      'Start the built-in orchestrator\'s setup run to GENERATE a team for a paused, ' +
      'orchestrator-only workspace (an alternative to create_team). Returns the run id; the ' +
      'human reviews and starts the workspace. 409 if a team already exists or a setup run is active.',
    input: GenerateAgentsInputSchema,
    output: GenerateAgentsResultSchema,
  },
  create_team: {
    description:
      'Atomically spawn a whole team of worker agents on a paused workspace that has no worker ' +
      'agents yet. Validated all-or-nothing against the live board and executor profiles; an ' +
      'invalid agent ⇒ 422 with path-qualified issues and ZERO created (fix the flagged field ' +
      'and retry). Does NOT start the workspace.',
    input: CreateTeamInputSchema,
    output: CreateTeamResponseSchema,
  },
  create_agent: {
    description:
      'Create a single worker agent. Runs the same server-side lint as the dashboard (statuses ' +
      'must exist on the board; no trigger collisions) → 422 with path-qualified issues on failure.',
    input: AdminCreateAgentInputSchema,
    output: AgentWriteResultSchema,
  },
  update_agent: {
    description:
      'Update a single agent by id (same server-side lint as create_agent). Cannot delete agents; ' +
      'the orchestrator is server-protected.',
    input: AdminUpdateAgentInputSchema,
    output: AgentWriteResultSchema,
  },
} as const;

export type AdminToolName = keyof typeof AdminTools;

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
export type CreateTeamInput = z.infer<typeof CreateTeamInputSchema>;
export type AdminCreateAgentInput = z.infer<typeof AdminCreateAgentInputSchema>;
export type AdminUpdateAgentInput = z.infer<typeof AdminUpdateAgentInputSchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type BoardStatusSummary = z.infer<typeof BoardStatusSummarySchema>;
export type ExecutorSummary = z.infer<typeof ExecutorSummarySchema>;
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
