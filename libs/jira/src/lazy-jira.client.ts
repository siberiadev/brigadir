import type { ADFDoc, JiraIssue, JiraTransition, JiraBoardType } from '@brigadir/contracts';
import type { JiraClient } from './jira-client.interface';

/**
 * A JiraClient that defers building the real client until the FIRST call
 * (Constitution lazy resource resolution). Boot stays credential-free: the DI
 * factory constructs only this wrapper; the `workspaces` row and its decrypted
 * credentials are read the first time a Jira operation actually runs, and the
 * resolved client is memoized. A failed resolution is NOT memoized, so a later
 * call retries once the workspace/credentials exist (e.g. after config seed).
 *
 * This is what lets the worker boot without any Jira credentials — the reconcile
 * pass resolves the client lazily, and a credential-less boot never crashes.
 */
export class LazyJiraClient implements JiraClient {
  private delegate: Promise<JiraClient> | undefined;

  constructor(private readonly resolver: () => Promise<JiraClient>) {}

  private client(): Promise<JiraClient> {
    if (!this.delegate) {
      this.delegate = this.resolver().catch((err: unknown) => {
        this.delegate = undefined; // allow a later retry once creds exist
        throw err;
      });
    }
    return this.delegate;
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
  async transitionTo(issueKey: string, targetStatusName: string): Promise<void> {
    return (await this.client()).transitionTo(issueKey, targetStatusName);
  }
  async addComment(issueKey: string, body: ADFDoc): Promise<void> {
    return (await this.client()).addComment(issueKey, body);
  }
}
