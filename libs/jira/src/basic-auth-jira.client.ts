import { Logger } from '@nestjs/common';
import type {
  ADFDoc,
  JiraIssue,
  JiraTransition,
  JiraBoardType,
} from '@brigadir/contracts';
import type { JiraClient } from './jira-client.interface';
import { RateLimiter } from './rate-limiter';
import { PerIssueWriteQueue } from './per-issue-write-queue';
import { TransitionDiscovery, type TransitionPort } from './transition-discovery';
import { JiraHttpError, JiraRateLimited } from './jira.errors';

export interface BasicAuthJiraClientConfig {
  baseUrl: string; // https://acme.atlassian.net
  email: string;
  apiToken: string;
  maxRps?: number;
  concurrency?: number;
  transitionCacheTtlMs?: number;
}

interface SearchPage {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

/**
 * JiraClient over native fetch (research D1). Reads are rate-limited; mutations
 * are additionally serialized per issue key (Principle III). A 429 is turned
 * into `JiraRateLimited` so the rate limiter waits `Retry-After` and retries
 * transparently (FR-003). No Atlassian SDK — exact header/retry control.
 */
export class BasicAuthJiraClient implements JiraClient {
  private readonly logger = new Logger(BasicAuthJiraClient.name);
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly rateLimiter: RateLimiter;
  private readonly perIssue = new PerIssueWriteQueue();
  private readonly discovery: TransitionDiscovery;

  constructor(cfg: BasicAuthJiraClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
    this.rateLimiter = new RateLimiter({ maxRps: cfg.maxRps, concurrency: cfg.concurrency });
    const port: TransitionPort = {
      getContext: (key) => this.getIssueContext(key),
      listTransitions: (key) => this.getTransitions(key),
      postTransition: (key, id) =>
        this.request<void>('POST', `/rest/api/3/issue/${key}/transitions`, {
          transition: { id },
        }),
    };
    this.discovery = new TransitionDiscovery(port, cfg.transitionCacheTtlMs);
  }

  // --- core request (rate-limited; 429 → JiraRateLimited) ---
  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.rateLimiter.schedule(async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        throw new JiraRateLimited(parseRetryAfter(res), res.headers.get('RateLimit-Reason') ?? undefined);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new JiraHttpError(res.status, method, path, text);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    });
  }

  // --- reads ---
  async searchUpdated(jql: string, fields: string[]): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<SearchPage>('POST', '/rest/api/3/search/jql', {
        jql,
        fields,
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      if (page.issues?.length) out.push(...page.issues);
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  async getBoard(boardId: number): Promise<{ type: JiraBoardType; projectKey: string }> {
    const board = await this.request<{ type: string; location?: { projectKey?: string } }>(
      'GET',
      `/rest/agile/1.0/board/${boardId}`,
    );
    return {
      type: board.type === 'scrum' ? 'scrum' : 'kanban',
      projectKey: board.location?.projectKey ?? '',
    };
  }

  async getActiveSprintId(boardId: number): Promise<number | null> {
    const res = await this.request<{ values?: Array<{ id: number }> }>(
      'GET',
      `/rest/agile/1.0/board/${boardId}/sprint?state=active`,
    );
    return res.values?.[0]?.id ?? null;
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions?: Array<{ id: string; to?: { name?: string } }> }>(
      'GET',
      `/rest/api/3/issue/${issueKey}/transitions`,
    );
    return (res.transitions ?? []).map((t) => ({ id: t.id, to: { name: t.to?.name ?? '' } }));
  }

  private async getIssueContext(
    issueKey: string,
  ): Promise<{ projectKey: string; issueType: string; currentStatus: string }> {
    const issue = await this.request<{
      fields: { status?: { name?: string }; issuetype?: { name?: string }; project?: { key?: string } };
    }>('GET', `/rest/api/3/issue/${issueKey}?fields=status,issuetype,project`);
    return {
      projectKey: issue.fields.project?.key ?? '',
      issueType: issue.fields.issuetype?.name ?? '',
      currentStatus: issue.fields.status?.name ?? '',
    };
  }

  // --- mutations (serialized per issue key) ---
  transitionTo(issueKey: string, targetStatusName: string): Promise<void> {
    return this.perIssue.run(issueKey, () => this.discovery.transitionTo(issueKey, targetStatusName));
  }

  addComment(issueKey: string, body: ADFDoc): Promise<void> {
    return this.perIssue.run(issueKey, () =>
      this.request<void>('POST', `/rest/api/3/issue/${issueKey}/comment`, { body }),
    );
  }
}

/** Retry-After is seconds or an HTTP-date; fall back to 1s when absent/unparseable. */
function parseRetryAfter(res: Response): number {
  const h = res.headers.get('Retry-After');
  if (!h) return 1000;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 1000;
}
