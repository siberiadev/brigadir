import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { BasicAuthJiraClient } from './basic-auth-jira.client';
import { decodeJiraCredentials } from './credentials.codec';
import { JiraAuthError } from './jira.errors';
import type { JiraClient } from './jira-client.interface';

export interface CandidateCredentials {
  siteUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Builds JiraClients outside the memoized global `JIRA_CLIENT` (feature 005, R6).
 *
 * - `fromCredentials`: throwaway client from EXPLICIT candidate credentials —
 *   wizard Verify (pre-persist) and token rotation, which must not read the
 *   persisted row.
 * - `forWorkspace`: client for a SPECIFIC workspace row. The global
 *   `JIRA_CLIENT` resolves `workspaces LIMIT 1` (the iteration-2
 *   single-workspace assumption) — with 2+ workspaces every per-workspace
 *   dashboard path (statuses, …) would hit the WRONG site/credentials
 *   (found live: the seeded placeholder shadowed a real wizard-created
 *   workspace). Cached per workspace id, keyed by a fingerprint of
 *   site URL + credential bytes, so token rotation rebuilds on next use.
 */
@Injectable()
export class JiraClientFactory {
  private readonly byWorkspace = new Map<string, { fingerprint: string; client: JiraClient }>();

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  fromCredentials(creds: CandidateCredentials): JiraClient {
    return new BasicAuthJiraClient({
      baseUrl: creds.siteUrl,
      email: creds.email,
      apiToken: creds.apiToken,
      maxRps: Number(process.env.JIRA_MAX_RPS ?? 5),
      concurrency: Number(process.env.JIRA_MAX_CONCURRENCY ?? 8),
    });
  }

  async forWorkspace(workspaceId: string): Promise<JiraClient> {
    const [row] = await this.db
      .select({
        siteUrl: schema.workspaces.jiraSiteUrl,
        credentials: schema.workspaces.jiraCredentials,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    if (!row) {
      throw new JiraAuthError(`workspace ${workspaceId} not found`);
    }

    const fingerprint = createHash('sha256')
      .update(row.siteUrl)
      .update(Buffer.from(row.credentials))
      .digest('hex');
    const cached = this.byWorkspace.get(workspaceId);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.client;
    }

    const creds = decodeJiraCredentials(row.credentials);
    const client = this.fromCredentials({
      siteUrl: row.siteUrl,
      email: creds.email,
      apiToken: creds.api_token,
    });
    this.byWorkspace.set(workspaceId, { fingerprint, client });
    return client;
  }
}
