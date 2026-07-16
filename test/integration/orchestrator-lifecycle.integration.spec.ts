import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema, DEFAULT_ORCHESTRATOR_INSTRUCTION, ORCHESTRATOR_AGENT_NAME } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { OrchestratorBackfillService } from '../../apps/backend/src/dashboard/orchestrator-backfill.service';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

const GOOD = { email: 'bot@acme.com', token: 'good-token' };

/**
 * T038 (US4, SC-005/006): orchestrator lifecycle. Wizard create seeds a
 * "brigadir" orchestrator (never poll-triggered, default instruction copied);
 * startup backfill seeds a pre-existing workspace lacking one; delete via API is
 * 409 while instruction edits succeed; changing the default then creating a
 * workspace uses the new default and leaves existing orchestrators unchanged.
 */
describe('orchestrator lifecycle (T038)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let app: INestApplication;
  let url: string;
  let jira: MockJira;

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${TEST_DASHBOARD_TOKEN}` };

  beforeAll(async () => {
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = join(process.cwd(), 'test', 'fixtures', 'does-not-exist.yaml');
    jira = mockJira({ boardId: 42, projectKey: 'BRIG' });
    jira.server.listen({ onUnhandledRequest: 'bypass' });
    jira.expectAuth(GOOD.email, GOOD.token);
    jira.setBotDisplayName('BRIGADIR Bot');

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  }, 240_000);

  afterAll(async () => {
    jira?.server.close();
    await app?.close();
    await db?.stop();
    await redis?.stop();
  });

  const createWorkspace = (name: string) =>
    fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name,
        jira_site_url: jira.baseUrl,
        jira_email: GOOD.email,
        jira_api_token: GOOD.token,
        expires_at: '2027-07-12T00:00:00.000Z',
        board: '42',
        repositories: [],
      }),
    });

  async function orchestratorFor(workspaceId: string) {
    const [row] = await db.db
      .select()
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, workspaceId),
          eq(schema.agents.name, ORCHESTRATOR_AGENT_NAME),
        ),
      )
      .limit(1);
    return row;
  }

  it('AC US4-1: wizard create seeds a never-poll-triggered orchestrator with the default instruction', async () => {
    const res = await createWorkspace('Acme');
    expect(res.status).toBe(201);
    const ws = await res.json();

    const orch = await orchestratorFor(ws.id);
    expect(orch).toBeDefined();
    expect(orch.isOrchestrator).toBe(true);
    expect(orch.triggerStatus).toBeNull(); // never poll-triggered
    expect(orch.triggerJql).toBeNull();
    expect(orch.instruction).toBe(DEFAULT_ORCHESTRATOR_INSTRUCTION);
    expect(orch.enabled).toBe(true);
  });

  it('AC US4-2: startup backfill seeds a pre-existing workspace lacking an orchestrator', async () => {
    // A workspace inserted directly (no seeding) — as if it predates the feature.
    const [ws] = await db.db
      .insert(schema.workspaces)
      .values({
        name: 'Legacy',
        jiraSiteUrl: jira.baseUrl,
        jiraProjectKey: 'BRIG',
        jiraBoardId: 42,
        jiraBoardType: 'kanban',
        jiraCredentials: encodeJiraCredentials({ email: GOOD.email, api_token: GOOD.token }),
      })
      .returning({ id: schema.workspaces.id });
    expect(await orchestratorFor(ws.id)).toBeUndefined();

    // Run the backfill (as it runs at bootstrap).
    await app.get(OrchestratorBackfillService).run();

    const orch = await orchestratorFor(ws.id);
    expect(orch).toBeDefined();
    expect(orch.isOrchestrator).toBe(true);
  });

  it('AC US4-3: delete → 409; instruction + enabled edits succeed', async () => {
    const res = await createWorkspace('DeleteGuard');
    const ws = await res.json();
    const orch = await orchestratorFor(ws.id);

    // DELETE → 409.
    const del = await fetch(`${url}/api/agents/${orch.id}`, { method: 'DELETE', headers: authHeaders });
    expect(del.status).toBe(409);

    // PUT instruction + disable → succeeds (trigger/status fields are ignored for the orchestrator).
    const put = await fetch(`${url}/api/agents/${orch.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        workspace_id: ws.id,
        name: 'brigadir',
        instruction: 'Custom orchestrator instruction.',
        executor_id: orch.executorId,
        trigger_status: 'ignored',
        status_success: 'ignored',
        status_failure: 'ignored',
        enabled: false,
      }),
    });
    expect(put.status).toBe(200);

    const after = await orchestratorFor(ws.id);
    expect(after.instruction).toBe('Custom orchestrator instruction.');
    expect(after.enabled).toBe(false);
    expect(after.isOrchestrator).toBe(true); // still the orchestrator
    expect(after.triggerStatus).toBeNull(); // trigger fields preserved
  });

  it('AC US4-4 / SC-006: changing the default affects only workspaces created afterward', async () => {
    const wsA = await (await createWorkspace('BeforeChange')).json();
    const orchABefore = await orchestratorFor(wsA.id);

    const newDefault = 'A brand new default triage instruction.';
    const putRes = await fetch(`${url}/api/general-settings`, {
      method: 'PUT',
      headers: authHeaders,
      // Both fields are required since the editable setup protocol (2026-07-17).
      body: JSON.stringify({
        default_orchestrator_instruction: newDefault,
        workspace_setup_instruction: 'Study the board, then propose the team.',
      }),
    });
    expect(putRes.status).toBe(200);

    const wsB = await (await createWorkspace('AfterChange')).json();
    const orchB = await orchestratorFor(wsB.id);
    expect(orchB.instruction).toBe(newDefault); // new default used

    // A's orchestrator is untouched.
    const orchAAfter = await orchestratorFor(wsA.id);
    expect(orchAAfter.instruction).toBe(orchABefore.instruction);
    expect(orchAAfter.instruction).not.toBe(newDefault);
  });
});
