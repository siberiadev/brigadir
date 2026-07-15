import type {
  ADFDoc,
  JiraIssue,
  JiraTransition,
  JiraBoardType,
  JiraFeatureContext,
  BoardStatus,
} from '@brigadir/contracts';

/**
 * The single typed surface for Jira (contracts.md C1). `BasicAuthJiraClient`
 * implements it; a later `OAuthJiraClient` can be added without touching
 * callers. Reads are rate-limited; mutations are additionally serialized per
 * issue key (Principle III — only the system writes, one writer per issue).
 */
export interface JiraClient {
  // --- reads ---
  /** POST /rest/api/3/search/jql, following nextPageToken; explicit fields required. */
  searchUpdated(jql: string, fields: string[]): Promise<JiraIssue[]>;
  /** GET /rest/agile/1.0/board/{id} → board type + project key. */
  getBoard(boardId: number): Promise<{ type: JiraBoardType; projectKey: string }>;
  /** Head of openSprints() for the board, or null when none is active. */
  getActiveSprintId(boardId: number): Promise<number | null>;
  /** GET /issue/{key}/transitions — raw available transitions. */
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  /** GET /issue/{key}?fields=parent,issuelinks — epic + linked issues, statuses only (feature 004, FR-026). */
  getFeatureContext(issueKey: string): Promise<JiraFeatureContext>;
  /**
   * GET /issue/{key}?fields=summary,description — full issue text for the run
   * wrapper. `description` is ADF on Jira Cloud v3; a plain string is tolerated
   * defensively (Server / API v2). Conversion to markdown is the caller's
   * concern (adf-to-markdown.ts) — the client returns Jira ground truth.
   */
  getIssue(issueKey: string): Promise<{ summary: string | null; description: ADFDoc | string | null }>;
  /** GET /rest/api/3/myself — the authenticated bot identity (feature 005, wizard Verify). */
  getMyself(): Promise<{ displayName: string }>;
  /**
   * GET /rest/api/3/project/{projectKey}/statuses — the project's statuses,
   * flattened across issue types and de-duped by status id into a flat,
   * column-less list (feature 005, R3 / FR-011).
   */
  getProjectStatuses(projectKey: string): Promise<BoardStatus[]>;

  // --- mutations (serialized per issue key) ---
  /** Discover→match-by-name→POST; TTL cache; 409 retry once; NoTransitionPath. */
  transitionTo(issueKey: string, targetStatusName: string): Promise<void>;
  addComment(issueKey: string, body: ADFDoc): Promise<void>;
}

export const JIRA_CLIENT = Symbol('JIRA_CLIENT');
