import { Injectable } from '@nestjs/common';
import { BasicAuthJiraClient } from './basic-auth-jira.client';
import type { JiraClient } from './jira-client.interface';

export interface CandidateCredentials {
  siteUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Builds a throwaway JiraClient from EXPLICIT candidate credentials (feature
 * 005, R6). The wizard Verify (pre-persist) and token rotation must validate
 * credentials that are not yet stored, so they must NOT go through the memoized
 * `JIRA_CLIENT` (which reads the persisted workspace row). This factory reads
 * nothing from the DB — it constructs a client straight from the submitted
 * `{ siteUrl, email, apiToken }`.
 */
@Injectable()
export class JiraClientFactory {
  fromCredentials(creds: CandidateCredentials): JiraClient {
    return new BasicAuthJiraClient({
      baseUrl: creds.siteUrl,
      email: creds.email,
      apiToken: creds.apiToken,
      maxRps: Number(process.env.JIRA_MAX_RPS ?? 5),
      concurrency: Number(process.env.JIRA_MAX_CONCURRENCY ?? 8),
    });
  }
}
