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
  fields: { status: JiraStatus };
}

export interface JiraIssueLink {
  type: JiraIssueLinkType;
  inwardIssue?: JiraLinkedIssueRef;
  outwardIssue?: JiraLinkedIssueRef;
}

export interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary: string | null;
    status: JiraStatus;
    updated: string; // ISO 8601
    issuelinks?: JiraIssueLink[];
  };
}

export interface JiraTransition {
  id: string;
  to: { name: string };
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
 * `workspaces.settings` blob (data-model.md). All optional; absent = defaults.
 * scope_jql is the global ingest filter (FR-038); the reconcile object carries
 * the high-water mark and last-seen active sprint id (FR-014, FR-032).
 */
export const WorkspaceSettingsSchema = z
  .object({
    scope_jql: z.string().min(1).optional(),
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
