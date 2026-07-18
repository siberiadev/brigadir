import type {
  ADFDoc,
  JiraIssue,
  JiraTransition,
  JiraBoardType,
  JiraFeatureContext,
  BoardStatus,
} from '@brigadir/contracts';
import type { JiraClient, JiraIssueDetail } from './jira-client.interface';

/**
 * What the resolver returns on each resolution: a cheap credential
 * `fingerprint` and a `build()` that constructs the real client. The fingerprint
 * is read cheaply every call; the (more expensive) `build()` runs only when the
 * fingerprint changed.
 */
export interface ResolvedClientSource {
  fingerprint: string;
  build: () => JiraClient;
}

/**
 * A JiraClient that defers building the real client until the FIRST call
 * (Constitution lazy resource resolution) and — feature 005, R6 — rebuilds it
 * when the workspace credentials change (token rotation).
 *
 * The write-once memo was a rotation-invalidation hole: a rotated (possibly
 * compromised) token left the memoized client authenticating with the OLD
 * credentials, and the memo lives in the *worker* while rotation happens in the
 * *backend* — a cross-process problem. The fix: on each call the resolver
 * returns a cheap credential fingerprint (a hash of the `jira_credentials`
 * bytes); the built client is memoized alongside it and REUSED while the
 * fingerprint is unchanged, and REBUILT the moment it changes. Both processes
 * re-read the row, so a rotation takes effect on the next Jira call in each.
 *
 * A failed resolution is NOT memoized, so a later call retries once the
 * workspace/credentials exist (credential-free boot preserved).
 */
export class LazyJiraClient implements JiraClient {
  private memo: { fingerprint: string; client: JiraClient } | undefined;

  constructor(private readonly resolver: () => Promise<ResolvedClientSource>) {}

  private async client(): Promise<JiraClient> {
    const { fingerprint, build } = await this.resolver();
    if (this.memo && this.memo.fingerprint === fingerprint) {
      return this.memo.client; // unchanged creds → reuse (keeps rate-limiter state)
    }
    const client = build(); // first use OR rotation → (re)build
    this.memo = { fingerprint, client };
    return client;
  }

  async searchUpdated(jql: string, fields: string[]): Promise<JiraIssue[]> {
    return (await this.client()).searchUpdated(jql, fields);
  }
  async getBoard(boardId: number): Promise<{ type: JiraBoardType; projectKey: string }> {
    return (await this.client()).getBoard(boardId);
  }
  async getActiveSprintId(boardId: number): Promise<number | null> {
    return (await this.client()).getActiveSprintId(boardId);
  }
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    return (await this.client()).getTransitions(issueKey);
  }
  async getFeatureContext(issueKey: string): Promise<JiraFeatureContext> {
    return (await this.client()).getFeatureContext(issueKey);
  }
  async getIssue(
    issueKey: string,
  ): Promise<{ summary: string | null; description: ADFDoc | string | null; components: string[] }> {
    return (await this.client()).getIssue(issueKey);
  }
  async getMyself(): Promise<{ displayName: string }> {
    return (await this.client()).getMyself();
  }
  async getProjectStatuses(projectKey: string): Promise<BoardStatus[]> {
    return (await this.client()).getProjectStatuses(projectKey);
  }
  async getProjectIssueTypes(projectKey: string): Promise<string[]> {
    return (await this.client()).getProjectIssueTypes(projectKey);
  }
  async getIssueDetail(issueKey: string): Promise<JiraIssueDetail> {
    return (await this.client()).getIssueDetail(issueKey);
  }
  async searchIssues(jql: string, fields: string[], maxResults: number): Promise<JiraIssue[]> {
    return (await this.client()).searchIssues(jql, fields, maxResults);
  }
  async transitionTo(issueKey: string, targetStatusName: string): Promise<void> {
    return (await this.client()).transitionTo(issueKey, targetStatusName);
  }
  async addComment(issueKey: string, body: ADFDoc): Promise<void> {
    return (await this.client()).addComment(issueKey, body);
  }
}
