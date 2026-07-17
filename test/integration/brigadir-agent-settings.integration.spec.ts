import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { schema, getWorkspaceSetupInstruction, getDefaultOrchestratorInstruction } from '@brigadir/database';
import {
  DEFAULT_BRIGADIR_AGENT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
  WORKSPACE_SETUP_INSTRUCTION_KEY,
  BRIGADIR_AGENT_TEMPLATE_KEY,
  type BrigadirAgentSettings,
} from '@brigadir/contracts';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, TEST_DASHBOARD_TOKEN, DbHarness, RedisHarness } from './harness';
import { mockJira, type MockJira } from './mock-jira';

/**
 * Feature 015 (T009, FR-007/008/011, US1/US3): GET/PUT
 * /api/brigadir-agent-settings — the template document + the two relocated
 * instruction texts. Supersedes the general-settings suite: legacy-key
 * continuity is asserted here (stored operator edits made under the old
 * General endpoint stay visible, spec FR-005/SC-006).
 */
describe('brigadir agent settings API (feature 015)', () => {
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

  const get = () => fetch(`${url}/api/brigadir-agent-settings`, { headers: authHeaders });
  const put = (body: unknown) =>
    fetch(`${url}/api/brigadir-agent-settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify(body),
    });

  /** A fresh valid payload based on the built-in defaults. */
  const defaultsPayload = (): BrigadirAgentSettings => ({
    template: structuredClone(DEFAULT_BRIGADIR_AGENT_TEMPLATE) as BrigadirAgentSettings['template'],
    routing_instruction: DEFAULT_ORCHESTRATOR_INSTRUCTION,
    workspace_setup_instruction: DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  });

  it('GET before any PUT returns the built-in defaults (template + both texts)', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toEqual(DEFAULT_BRIGADIR_AGENT_TEMPLATE);
    expect(body.routing_instruction).toBe(DEFAULT_ORCHESTRATOR_INSTRUCTION);
    expect(body.workspace_setup_instruction).toBe(DEFAULT_WORKSPACE_SETUP_INSTRUCTION);
  });

  it('legacy-key continuity: values stored under the OLD keys are visible in GET (FR-005)', async () => {
    const routing = 'Legacy-edited routing text.';
    const setup = 'Legacy-edited setup protocol.';
    for (const [key, value] of [
      [DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY, routing],
      [WORKSPACE_SETUP_INSTRUCTION_KEY, setup],
    ] as const) {
      await db.db
        .insert(schema.globalSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.globalSettings.key, set: { value } });
    }

    const body = await (await get()).json();
    expect(body.routing_instruction).toBe(routing);
    expect(body.workspace_setup_instruction).toBe(setup);
  });

  it('PUT of the DEFAULT payload succeeds on a database with no workspaces (built-ins materialized)', async () => {
    const res = await put(defaultsPayload());
    expect(res.status).toBe(200);

    // Both built-in profiles now exist.
    const names = (
      await db.db.select({ name: schema.executors.name }).from(schema.executors)
    ).map((r) => r.name);
    expect(names).toContain('brigadir-orchestrator');
    expect(names).toContain('brigadir-setup');
  });

  it('PUT then GET round-trips edited template values and texts; last write wins', async () => {
    const first = defaultsPayload();
    first.template.timeout_minutes = 30;
    first.template.max_budget_usd = 7.5;
    first.routing_instruction = 'First routing.';
    expect((await put(first)).status).toBe(200);

    const second = defaultsPayload();
    second.template.timeout_minutes = 20;
    second.template.max_attempts = 3;
    second.template.enabled = false;
    second.routing_instruction = 'Second routing.';
    second.workspace_setup_instruction = 'Second setup protocol.';
    expect((await put(second)).status).toBe(200);

    const body = await (await get()).json();
    expect(body.template.timeout_minutes).toBe(20);
    expect(body.template.max_attempts).toBe(3);
    expect(body.template.enabled).toBe(false);
    expect(body.template.max_budget_usd).toBeNull(); // full replacement, not a merge
    expect(body.routing_instruction).toBe('Second routing.');
    expect(body.workspace_setup_instruction).toBe('Second setup protocol.');

    // Restore defaults for any later cases.
    expect((await put(defaultsPayload())).status).toBe(200);
  });

  it('PUT rejects out-of-bounds limits and unknown keys with field-level issues (422)', async () => {
    const badBounds = defaultsPayload();
    badBounds.template.max_attempts = 0;
    const res1 = await put(badBounds);
    expect(res1.status).toBe(422);
    const body1 = await res1.json();
    expect(JSON.stringify(body1)).toContain('max_attempts');

    const unknownKey = { ...defaultsPayload(), theme: 'dark' };
    expect((await put(unknownKey)).status).toBe(422);
  });

  it('PUT rejects a non-existent and a disabled executor reference (422, field-level path)', async () => {
    const missing = defaultsPayload();
    missing.template.setup.executor = 'no-such-profile';
    const res1 = await put(missing);
    expect(res1.status).toBe(422);
    const body1 = await res1.json();
    expect(JSON.stringify(body1)).toContain('no-such-profile');

    await db.db
      .insert(schema.executors)
      .values({ name: 'disabled-profile', type: 'claude_cli', config: {}, enabled: false })
      .onConflictDoNothing({ target: schema.executors.name });
    const disabled = defaultsPayload();
    disabled.template.triage.executor = 'disabled-profile';
    const res2 = await put(disabled);
    expect(res2.status).toBe(422);
    const body2 = await res2.json();
    expect(JSON.stringify(body2)).toContain('is disabled');

    // Nothing persisted from the rejected PUTs.
    const body = await (await get()).json();
    expect(body.template.setup.executor).toBe('brigadir-setup');
    expect(body.template.triage.executor).toBe('brigadir-orchestrator');
  });

  it('live-read continuity (T025/FR-004): a PUT through the NEW endpoint is what the setup handoff reads', async () => {
    const payload = defaultsPayload();
    payload.workspace_setup_instruction = 'Recon first, then propose exactly three agents.';
    payload.routing_instruction = 'Route fast, escalate rarely.';
    expect((await put(payload)).status).toBe(200);

    // The exact readers the setup handoff (buildWorkspaceSetupSection) and the
    // seed use — key continuity proves edits made here reach the next run.
    expect(await getWorkspaceSetupInstruction(db.db)).toBe(
      'Recon first, then propose exactly three agents.',
    );
    expect(await getDefaultOrchestratorInstruction(db.db)).toBe('Route fast, escalate rarely.');

    expect((await put(defaultsPayload())).status).toBe(200);
  });

  it('a corrupt stored template is served as built-in defaults, never a 5xx (FR-011)', async () => {
    await db.db
      .insert(schema.globalSettings)
      .values({ key: BRIGADIR_AGENT_TEMPLATE_KEY, value: { schema_version: 99, garbage: true } })
      .onConflictDoUpdate({
        target: schema.globalSettings.key,
        set: { value: { schema_version: 99, garbage: true } },
      });

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toEqual(DEFAULT_BRIGADIR_AGENT_TEMPLATE);

    // The next successful PUT overwrites the corrupt value.
    expect((await put(defaultsPayload())).status).toBe(200);
    const [row] = await db.db
      .select({ value: schema.globalSettings.value })
      .from(schema.globalSettings)
      .where(eq(schema.globalSettings.key, BRIGADIR_AGENT_TEMPLATE_KEY))
      .limit(1);
    expect(row.value).toEqual(DEFAULT_BRIGADIR_AGENT_TEMPLATE);
  });
});
