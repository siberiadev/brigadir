import type { ADFDoc, JiraIssue, JiraTransition, JiraBoardType } from '@brigadir/contracts';

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

  // --- mutations (serialized per issue key) ---
  /** Discover→match-by-name→POST; TTL cache; 409 retry once; NoTransitionPath. */
  transitionTo(issueKey: string, targetStatusName: string): Promise<void>;
  addComment(issueKey: string, body: ADFDoc): Promise<void>;
}

export const JIRA_CLIENT = Symbol('JIRA_CLIENT');
