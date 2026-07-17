import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import {
  schema,
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  ORCHESTRATOR_AGENT_NAME,
  ORCHESTRATOR_EXECUTOR_NAME,
} from '@brigadir/database';
import {
  DEFAULT_BRIGADIR_AGENT_TEMPLATE,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  BRIGADIR_AGENT_TEMPLATE_KEY,
  type BrigadirAgentTemplate,
} from '@brigadir/contracts';
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
    // feature 015: the routing instruction is edited through the brigadir-agent
    // settings endpoint (the old /api/general-settings is gone); the storage
    // key is unchanged, so seeding semantics are identical.
    const putRes = await fetch(`${url}/api/brigadir-agent-settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        template: DEFAULT_BRIGADIR_AGENT_TEMPLATE,
        routing_instruction: newDefault,
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

  // ---- feature 015: template-driven seeding (T010, FR-009/010/011, SC-002) ----

  const templateOf = (patch: Partial<BrigadirAgentTemplate>): BrigadirAgentTemplate => ({
    ...(structuredClone(DEFAULT_BRIGADIR_AGENT_TEMPLATE) as BrigadirAgentTemplate),
    ...patch,
  });

  /** Write the template KV directly — also lets us store states PUT validation would reject. */
  async function storeTemplate(value: unknown) {
    await db.db
      .insert(schema.globalSettings)
      .values({ key: BRIGADIR_AGENT_TEMPLATE_KEY, value })
      .onConflictDoUpdate({ target: schema.globalSettings.key, set: { value } });
  }

  const putTemplateViaApi = (template: BrigadirAgentTemplate) =>
    fetch(`${url}/api/brigadir-agent-settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        template,
        routing_instruction: DEFAULT_ORCHESTRATOR_INSTRUCTION,
        workspace_setup_instruction: DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
      }),
    });

  it('feature 015: an edited template seeds workspaces created AFTER it; earlier ones keep their values (SC-002)', async () => {
    const wsBefore = await (await createWorkspace('TemplateBefore')).json();
    const orchBefore = await orchestratorFor(wsBefore.id);

    const putRes = await putTemplateViaApi(
      templateOf({ role: 'foreman', timeout_minutes: 33, max_budget_usd: 9.5, max_attempts: 4 }),
    );
    expect(putRes.status).toBe(200);

    const wsAfter = await (await createWorkspace('TemplateAfter')).json();
    const orch = await orchestratorFor(wsAfter.id);
    expect(orch.role).toBe('foreman');
    expect(orch.timeoutMinutes).toBe(33);
    expect(Number(orch.maxBudgetUsd)).toBe(9.5);
    expect(orch.maxAttempts).toBe(4);
    // Non-template invariants preserved (data-model §5).
    expect(orch.isOrchestrator).toBe(true);
    expect(orch.triggerStatus).toBeNull();
    expect(orch.statusSuccess).toBe('—');

    // The pre-existing workspace's orchestrator is byte-identical.
    expect(await orchestratorFor(wsBefore.id)).toEqual(orchBefore);
  });

  it('feature 015 (FR-010): a template executor deleted AFTER save falls back to the built-in profile + warning', async () => {
    // Simulate "profile deleted later": the stored template references a name
    // that no longer exists (a PUT would 422, so write the KV directly).
    await storeTemplate(templateOf({ triage: { executor: 'ghost-profile', behavior: { workspace_mode: 'none' } } }));

    const res = await createWorkspace('FallbackWs');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toBeDefined();
    expect(body.warnings[0].message).toContain('ghost-profile');
    expect(body.warnings[0].level).toBe('warning');

    const orch = await orchestratorFor(body.id);
    const [profile] = await db.db
      .select({ name: schema.executors.name })
      .from(schema.executors)
      .where(eq(schema.executors.id, orch.executorId))
      .limit(1);
    expect(profile.name).toBe(ORCHESTRATOR_EXECUTOR_NAME);
  });

  it('feature 015 (FR-011): a corrupt stored template seeds with built-in defaults, creation succeeds', async () => {
    await storeTemplate('not even an object');

    const res = await createWorkspace('CorruptTemplateWs');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings).toBeUndefined();

    const orch = await orchestratorFor(body.id);
    expect(orch.timeoutMinutes).toBe(DEFAULT_BRIGADIR_AGENT_TEMPLATE.timeout_minutes);
    expect(orch.role).toBe(DEFAULT_BRIGADIR_AGENT_TEMPLATE.role);
  });

  it('feature 015: template enabled=false seeds a disabled orchestrator (spec edge case)', async () => {
    expect((await putTemplateViaApi(templateOf({ enabled: false }))).status).toBe(200);

    const ws = await (await createWorkspace('DisabledSeedWs')).json();
    const orch = await orchestratorFor(ws.id);
    expect(orch.enabled).toBe(false);

    // Restore defaults so later suites sharing this file see clean state.
    expect((await putTemplateViaApi(templateOf({}))).status).toBe(200);
  });
});
