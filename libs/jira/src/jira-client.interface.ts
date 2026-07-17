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
  /**
   * ALL active (open) sprints on the board — a scrum board can run several in
   * parallel. Empty array when none is active. Callers scope with
   * `sprint in (…)` over the whole set (mirrors the board's own view).
   */
  getActiveSprintIds(boardId: number): Promise<number[]>;
  /** GET /issue/{key}/transitions — raw available transitions. */
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  /** GET /issue/{key}?fields=parent,issuelinks — epic + linked issues, statuses only (feature 004, FR-026). */
  getFeatureContext(issueKey: string): Promise<JiraFeatureContext>;
  /**
   * GET /issue/{key}?fields=summary,description,components — full issue text
   * for the run wrapper. `description` is ADF on Jira Cloud v3; a plain string
   * is tolerated defensively (Server / API v2). Conversion to markdown is the
   * caller's concern (adf-to-markdown.ts) — the client returns Jira ground
   * truth. `components` (feature 020) are the ticket's component NAMES —
   * repo-scoping input; absent field ⇒ [].
   */
  getIssue(
    issueKey: string,
  ): Promise<{ summary: string | null; description: ADFDoc | string | null; components: string[] }>;
  /** GET /rest/api/3/myself — the authenticated bot identity (feature 005, wizard Verify). */
  getMyself(): Promise<{ displayName: string }>;
  /**
   * GET /rest/api/3/project/{projectKey}/statuses — the project's statuses,
   * flattened across issue types and de-duped by status id into a flat,
   * column-less list (feature 005, R3 / FR-011).
   */
  getProjectStatuses(projectKey: string): Promise<BoardStatus[]>;
  /** The project's issue-type names, from the same /statuses response shape (feature 011, D7). */
  getProjectIssueTypes(projectKey: string): Promise<string[]>;
  /**
   * GET /issue/{key}?fields=summary,description,status,issuetype,labels,issuelinks,comment
   * — the full single-ticket read backing the `get_ticket` callback tool
   * (feature 011, D7). Comments newest-first; bodies are ADF (Cloud v3),
   * markdown conversion is the caller's concern.
   */
  getIssueDetail(issueKey: string): Promise<JiraIssueDetail>;
  /**
   * One bounded page of POST /rest/api/3/search/jql (never auto-paginates,
   * unlike searchUpdated) — backs the `search_tickets` callback tool
   * (feature 011, D7). Callers compose the JQL server-side (D6).
   */
  searchIssues(jql: string, fields: string[], maxResults: number): Promise<JiraIssue[]>;
  /**
   * POST /rest/api/3/search/approximate-count → the estimated number of issues
   * matching the JQL. The new /search/jql endpoint dropped `total`, so this is
   * the only way to get a count without paginating every page. Backs the
   * dashboard "preview ticket count" buttons (workspace scope + agent trigger).
   */
  approximateCount(jql: string): Promise<number>;

  // --- mutations (serialized per issue key) ---
  /** Discover→match-by-name→POST; TTL cache; 409 retry once; NoTransitionPath. */
  transitionTo(issueKey: string, targetStatusName: string): Promise<void>;
  addComment(issueKey: string, body: ADFDoc): Promise<void>;
}

/** The `get_ticket` read shape (feature 011). */
export interface JiraIssueDetail {
  key: string;
  summary: string | null;
  status: string;
  issueType: string;
  labels: string[];
  description: ADFDoc | string | null;
  links: Array<{ type: string; direction: 'inward' | 'outward'; key: string; status: string }>;
  /** Newest first. */
  comments: Array<{ author: string; created: string; body: ADFDoc | string | null }>;
  projectKey: string;
}

export const JIRA_CLIENT = Symbol('JIRA_CLIENT');
