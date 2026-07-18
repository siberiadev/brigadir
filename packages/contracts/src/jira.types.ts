import { z } from 'zod';

/**
 * Jira Cloud value types (REST v3 + Agile 1.0) and the workspace settings blob.
 * Normative source: docs/architecture.md §3 (settings blob), docs/research.md §5
 * (Jira API ground truth), specs/002-jira-core/contracts/contracts.md C2.
 *
 * These are the shapes the JiraClient (libs/jira) parses and the mock Jira
 * reproduces; kept framework-free here so every consumer shares one definition.
 */

// --- Atlassian Document Format (comments are ADF-only in v3) ---
export interface ADFNode {
  type: string;
  content?: ADFNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}
export interface ADFDoc {
  version: 1;
  type: 'doc';
  content: ADFNode[];
}

// --- Jira issue value types ---
export type StatusCategoryKey = 'new' | 'indeterminate' | 'done';

export interface JiraStatus {
  name: string;
  statusCategory: { key: StatusCategoryKey };
}

export interface JiraIssueLinkType {
  name: string; // e.g. "Blocks"
  inward: string; // e.g. "is blocked by"
  outward: string; // e.g. "blocks"
}

export interface JiraLinkedIssueRef {
  key: string;
  fields: { status: JiraStatus; summary?: string | null };
}

export interface JiraIssueLink {
  type: JiraIssueLinkType;
  inwardIssue?: JiraLinkedIssueRef;
  outwardIssue?: JiraLinkedIssueRef;
}

/**
 * Issue priority (feature 022). Jira's built-in scheme uses numeric string ids
 * ordered Highest("1") → Lowest("5"); custom schemes may deviate — the ingest
 * parses the id as an int and orders ascending (deterministic either way).
 */
export interface JiraPriority {
  id: string;
  name: string;
}

export interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary: string | null;
    status: JiraStatus;
    updated: string; // ISO 8601
    issuelinks?: JiraIssueLink[];
    priority?: JiraPriority | null;
    // Resolution is fetched ONLY by the sequencing blocker probe (feature 022);
    // regular poll payloads omit it.
    resolution?: { name: string } | null;
  };
}

export interface JiraTransition {
  id: string;
  to: { name: string };
}

/**
 * Bounded feature-context read (feature 004, D5/FR-026): the ticket's epic
 * and its linked issues, statuses only — no bodies/comments.
 */
export interface JiraFeatureContext {
  epic?: { key: string; status: string };
  linked: { key: string; status: string; summary: string }[];
}

/** Board type governs the poller scope (kanban = project; scrum = active sprint). */
export type JiraBoardType = 'kanban' | 'scrum';

/**
 * Workspace credentials for basic auth. Iteration 2 stores these as a JSON blob
 * in `workspaces.jira_credentials` (bytea); AES-256-GCM encryption is a later
 * concern — the codec seam lives in libs/jira.
 */
export const JiraCredentialsSchema = z
  .object({
    email: z.string().min(1),
    api_token: z.string().min(1),
  })
  .strict();
export type JiraCredentials = z.infer<typeof JiraCredentialsSchema>;

/**
 * A git repository the workspace operates on (feature 005). Lives in the
 * `workspaces.settings` blob as an ordered list — index 0 is the default an
 * agent inherits when its own `repository` is empty (FR-004/FR-008).
 */
export const WorkspaceRepositorySchema = z
  .object({
    name: z.string().min(1),
    git_url: z.string().min(1),
    default_branch: z.string().min(1),
  })
  .strict();
export type WorkspaceRepository = z.infer<typeof WorkspaceRepositorySchema>;

/**
 * `workspaces.settings` blob (data-model.md). All optional; absent = defaults.
 * scope_jql is the global ingest filter (FR-038); the reconcile object carries
 * the high-water mark and last-seen active sprint id (FR-014, FR-032). Feature
 * 005 adds the ordered `repositories` list (first = default).
 */
export const WorkspaceSettingsSchema = z
  .object({
    scope_jql: z.string().min(1).optional(),
    // Ordered; first = the default repository agents inherit (feature 005).
    repositories: z.array(WorkspaceRepositorySchema).optional(),
    // Workspace pause flag (feature 006, data-model additive item 2). ABSENT ⇒
    // treated as enabled; the reconcile pass selects
    // `settings->>'enabled' IS DISTINCT FROM 'false'`. No DDL — jsonb value only.
    enabled: z.boolean().optional(),
    // Per-workspace rework-cycle budget (feature 010, FR-006). ABSENT ⇒ default 2
    // via the getReworkMax accessor. No DDL — jsonb value only.
    rework_max: z.number().int().positive().optional(),
    // Feature 020 (D2b): per-workspace opt-in for ticket repository scoping via
    // Jira Components (narrowing + the fail-closed gate). ABSENT ⇒ OFF —
    // byte-identical legacy behavior. No DDL — jsonb value only.
    ticket_scoping: z.boolean().optional(),
    // iteration-1 seed leftovers (deprecated single-repo fields) tolerated:
    repo: z.string().optional(),
    default_branch: z.string().optional(),
    branch_prefix: z.string().optional(),
    reconcile: z
      .object({
        high_water_mark: z.string().datetime().optional(),
        active_sprint_id: z.number().int().nullable().optional(),
      })
      .optional(),
  })
  .passthrough();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
