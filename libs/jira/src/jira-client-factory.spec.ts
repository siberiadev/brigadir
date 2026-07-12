import { describe, it, expect } from 'vitest';
import { JiraClientFactory } from './jira-client-factory';
import { BasicAuthJiraClient } from './basic-auth-jira.client';

describe('JiraClientFactory (T135)', () => {
  it('builds a client from explicit candidate credentials without touching the DB', () => {
    const factory = new JiraClientFactory();
    const client = factory.fromCredentials({
      siteUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      apiToken: 'candidate-token',
    });
    expect(client).toBeInstanceOf(BasicAuthJiraClient);
    // the read surface the wizard Verify needs is present
    expect(typeof client.getMyself).toBe('function');
    expect(typeof client.getBoard).toBe('function');
    expect(typeof client.getProjectStatuses).toBe('function');
  });
});
