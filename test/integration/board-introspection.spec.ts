import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { DatabaseModule, schema } from '@brigadir/database';
import {
  JiraModule,
  WorkspaceConnectionService,
  encodeJiraCredentials,
} from '@brigadir/jira';
import { eq } from 'drizzle-orm';
import { startDatabase, DbHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';

const BASE = 'https://mock.atlassian.net';

/**
 * T049 (FR-028): connect-time board introspection populates jira_board_type via
 * the Agile API; an inaccessible board fails with a clear diagnostic.
 */
describe('board introspection at connect (T049)', () => {
  let h: DbHarness;
  let mock: MockJira;

  beforeAll(async () => {
    h = await startDatabase();
    process.env.DATABASE_URL = h.url;
    mock = mockJira({ baseUrl: BASE, boardId: 42, boardType: 'scrum', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });
  }, 180_000);
  afterAll(async () => {
    mock.server.close();
    await h?.stop();
  });

  async function seedWorkspace(boardId: number): Promise<string> {
    await h.db.delete(schema.workspaces);
    const [ws] = await h.db
      .insert(schema.workspaces)
      .values({
        name: 'ws',
        jiraSiteUrl: BASE,
        jiraProjectKey: 'BRIG',
        jiraBoardId: boardId,
        jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
      })
      .returning({ id: schema.workspaces.id });
    return ws.id;
  }

  async function connectionService(): Promise<{
    svc: WorkspaceConnectionService;
    close: () => Promise<void>;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ databaseUrl: h.url }), JiraModule.forRootAsync()],
    }).compile();
    return { svc: moduleRef.get(WorkspaceConnectionService), close: () => moduleRef.close() };
  }

  it('populates jira_board_type from the Agile API (scrum board)', async () => {
    const workspaceId = await seedWorkspace(42);
    const { svc, close } = await connectionService();
    const type = await svc.introspectAndPersistBoardType(workspaceId);
    await close();

    expect(type).toBe('scrum');
    const [ws] = await h.db
      .select({ boardType: schema.workspaces.jiraBoardType })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    expect(ws.boardType).toBe('scrum');
  });

  it('fails with a clear diagnostic for an inaccessible board', async () => {
    const workspaceId = await seedWorkspace(999); // mock 404s unknown boards
    const { svc, close } = await connectionService();
    await expect(svc.introspectAndPersistBoardType(workspaceId)).rejects.toThrow(
      /not accessible|board 999/i,
    );
    await close();
  });
});
