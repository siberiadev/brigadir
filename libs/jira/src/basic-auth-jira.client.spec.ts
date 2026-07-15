import { describe, it, expect, vi, afterEach } from 'vitest';
import { BasicAuthJiraClient } from './basic-auth-jira.client';

function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const client = new BasicAuthJiraClient({
  baseUrl: 'https://acme.atlassian.net',
  email: 'bot@acme.com',
  apiToken: 'tok',
});

describe('BasicAuthJiraClient read surface (T134)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('getMyself returns the display name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ displayName: 'BRIGADIR Bot' }));
    expect(await client.getMyself()).toEqual({ displayName: 'BRIGADIR Bot' });
  });

  it('getIssue returns summary and the raw ADF description', async () => {
    const adf = {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
    };
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ fields: { summary: 'Fix it', description: adf } }));

    expect(await client.getIssue('BRIG-1')).toEqual({ summary: 'Fix it', description: adf });
    expect(String(spy.mock.calls[0][0])).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/BRIG-1?fields=summary,description',
    );
  });

  it('getIssue tolerates a missing description and summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ fields: {} }));
    expect(await client.getIssue('BRIG-2')).toEqual({ summary: null, description: null });
  });

  it('getProjectStatuses flattens statuses across issue types and de-dupes by id', async () => {
    // Same status id (10001) appears under two issue types → collapsed to one.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          name: 'Task',
          statuses: [
            { id: '10001', name: 'Ready for Dev', statusCategory: { key: 'new' } },
            { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          ],
        },
        {
          name: 'Bug',
          statuses: [
            { id: '10001', name: 'Ready for Dev', statusCategory: { key: 'new' } },
            { id: '10002', name: 'Done', statusCategory: { key: 'done' } },
          ],
        },
      ]),
    );

    const statuses = await client.getProjectStatuses('BRIG');
    expect(statuses.map((s) => s.id)).toEqual(['10001', '3', '10002']); // flat, de-duped, no columns
    expect(statuses[0]).toEqual({ id: '10001', name: 'Ready for Dev', statusCategory: 'new' });
  });
});
