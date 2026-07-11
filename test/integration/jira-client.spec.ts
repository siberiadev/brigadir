import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { ADFDoc } from '@brigadir/contracts';
import { DatabaseModule, schema } from '@brigadir/database';
import {
  BasicAuthJiraClient,
  JiraModule,
  JIRA_CLIENT,
  encodeJiraCredentials,
  NoTransitionPath,
  type JiraClient,
} from '@brigadir/jira';
import { startDatabase, DbHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';

const adf = (marker: string): ADFDoc => ({
  version: 1,
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: marker }] }],
});
const markerOf = (doc: ADFDoc): string =>
  ((doc.content[0] as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '');

describe('BasicAuthJiraClient over mock Jira (T048/T052)', () => {
  let mock: MockJira;
  let client: BasicAuthJiraClient;

  beforeAll(() => {
    mock = mockJira({ baseUrl: BASE });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
    client = new BasicAuthJiraClient({ baseUrl: BASE, email: 'bot@acme.io', apiToken: 'tok' });
  });
  afterAll(() => mock.server.close());
  beforeEach(() => mock.reset());

  it('searchUpdated follows nextPageToken and returns the full set (T048)', async () => {
    for (let i = 1; i <= 5; i++) mock.seedIssue(`BRIG-${i}`, { status: 'Ready for Dev' });
    const issues = await client.searchUpdated('project = BRIG', ['status', 'summary', 'updated']);
    expect(issues).toHaveLength(5); // pageSize 2 → 3 pages
    expect(issues[0].fields.status.name).toBe('Ready for Dev');
  });

  it('serializes concurrent writes to one issue in submission order (SC-003)', async () => {
    mock.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    await Promise.all([0, 1, 2, 3, 4].map((i) => client.addComment('BRIG-1', adf(`c${i}`))));
    expect(mock.commentsFor('BRIG-1').map(markerOf)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('honors 429 + Retry-After and still completes the write (SC-004)', async () => {
    mock.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    mock.arm429(1); // next request → 429 Retry-After: 1s
    const t0 = Date.now();
    await client.addComment('BRIG-1', adf('after-429'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(mock.commentsFor('BRIG-1').map(markerOf)).toEqual(['after-429']);
  });

  // --- T052: transition discovery + 409 + NoTransitionPath + already-in-target ---

  it('transitions by discovering + matching the target status name', async () => {
    mock.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    await client.transitionTo('BRIG-1', 'Code Review');
    expect(mock.transitionsFor('BRIG-1')).toEqual(['Code Review']);
  });

  it('invalidates + retries once on a 409 transition conflict', async () => {
    mock.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    mock.arm409OnNextTransition('BRIG-1');
    await client.transitionTo('BRIG-1', 'Code Review');
    expect(mock.transitionsFor('BRIG-1')).toEqual(['Code Review']); // succeeded after retry
  });

  it('no-ops when already in the target status (FR-023)', async () => {
    mock.seedIssue('BRIG-1', { status: 'Code Review' });
    await client.transitionTo('BRIG-1', 'Code Review');
    expect(mock.transitionsFor('BRIG-1')).toEqual([]);
  });

  it('throws NoTransitionPath when the target status is unreachable', async () => {
    mock.seedIssue('BRIG-1', { status: 'Ready for Dev' });
    // remove "Done" from the catalog so no transition matches it
    await expect(client.transitionTo('BRIG-1', 'Nonexistent Status')).rejects.toBeInstanceOf(
      NoTransitionPath,
    );
  });
});

describe('JiraModule.forRootAsync resolves the client from the workspace row (T047)', () => {
  let h: DbHarness;
  let mock: MockJira;

  beforeAll(async () => {
    h = await startDatabase();
    process.env.DATABASE_URL = h.url;
    mock = mockJira({ baseUrl: BASE, boardType: 'scrum', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
  }, 180_000);
  afterAll(async () => {
    mock.server.close();
    await h?.stop();
  });

  async function seedWorkspace(credentials: Buffer): Promise<void> {
    await h.db.delete(schema.workspaces);
    await h.db.insert(schema.workspaces).values({
      name: 'ws',
      jiraSiteUrl: BASE,
      jiraProjectKey: 'BRIG',
      jiraBoardId: 42,
      jiraCredentials: credentials,
    });
  }

  it('builds the client at context init and issues a read (getBoard)', async () => {
    await seedWorkspace(encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }));
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ databaseUrl: h.url }), JiraModule.forRootAsync()],
    }).compile();
    const client = moduleRef.get<JiraClient>(JIRA_CLIENT);
    expect(await client.getBoard(42)).toEqual({ type: 'scrum', projectKey: 'BRIG' });
    await moduleRef.close();
  });

  it('fails clearly when credentials are the iteration-1 placeholder (no silent fallback)', async () => {
    await seedWorkspace(Buffer.from('placeholder-jira-credentials'));
    await expect(
      Test.createTestingModule({
        imports: [DatabaseModule.forRoot({ databaseUrl: h.url }), JiraModule.forRootAsync()],
      }).compile(),
    ).rejects.toThrow(/jira_credentials/i);
  });
});
