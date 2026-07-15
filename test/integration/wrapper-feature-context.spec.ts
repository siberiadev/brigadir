import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { encodeJiraCredentials } from '@brigadir/jira';
import { RunTriggerService } from '@brigadir/runs';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { BackendAppModule } from '../../apps/backend/src/app.module';
import { startDatabase, startRedis, seedPipeline, DbHarness, RedisHarness } from './harness';
import { mockJira, MockJira } from './mock-jira';
import {
  setupClaudeCliTestEnv,
  baseExecutorConfig,
  resetFakeClaudeEnv,
  setFakeClaudeCallbacks,
  type ClaudeCliTestEnv,
} from './claude-cli-harness';

const BASE = 'https://mock.atlassian.net';
const JWT_SECRET = 'wrapper-feature-context-test-jwt-secret';

/**
 * T115 (US6, D5, FR-026) — the instruction wrapper for a callback-wired run
 * includes the ticket's epic + linked issues with statuses, plus branch/PR
 * URLs extracted from a prior run's report on a linked issue.
 */
describe('wrapper feature-context (T115)', () => {
  let db: DbHarness;
  let redis: RedisHarness;
  let mock: MockJira;
  let worker: TestingModule;
  let backend: INestApplication;
  let backendUrl: string;
  let trigger: RunTriggerService;
  let env: ClaudeCliTestEnv;

  beforeAll(async () => {
    env = await setupClaudeCliTestEnv();
    db = await startDatabase();
    redis = await startRedis();
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = redis.url;
    process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;
    process.env.BRIGADIR_JWT_SECRET = JWT_SECRET;

    mock = mockJira({ baseUrl: BASE, boardType: 'kanban', projectKey: 'BRIG' });
    mock.server.listen({ onUnhandledRequest: 'bypass' });

    const backendModule = await Test.createTestingModule({ imports: [BackendAppModule] }).compile();
    backend = backendModule.createNestApplication();
    await backend.init();
    await backend.listen(0);
    backendUrl = await backend.getUrl();
    process.env.BRIGADIR_CALLBACK_BASE_URL = `${backendUrl}/api/callbacks`;

    worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    await worker.init();
    await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    trigger = worker.get(RunTriggerService);
  }, 240_000);

  afterAll(async () => {
    await worker?.close();
    await backend?.close();
    mock?.server.close();
    await db?.stop();
    await redis?.stop();
    resetFakeClaudeEnv();
    await env?.cleanup();
  });

  async function pollRun(
    runId: string,
    until: (status: string) => boolean,
    timeoutMs = 30_000,
  ): Promise<typeof schema.runs.$inferSelect> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await db.db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
      if (row && until(row.status)) return row;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} stuck at ${row?.status} after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const TERMINAL = (s: string): boolean =>
    ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'].includes(s);

  it('compiled wrapper lists the epic, the linked issue + status, and the branch/PR from its prior run', async () => {
    mock.seedIssue('BRIG-EPIC', { status: 'In Progress', summary: 'The parent feature' });
    mock.seedIssue('BRIG-SIB', { status: 'Code Review', summary: 'Sibling ticket already shipped a branch' });
    mock.seedIssue('BRIG-MAIN', { status: 'Ready for Dev' });
    mock.setEpic('BRIG-MAIN', 'BRIG-EPIC');
    mock.addLinkedIssue('BRIG-MAIN', 'BRIG-SIB');

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, keepFailedWorktrees: true }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'], branch_prefix: 'feat' },
      ticketKey: 'BRIG-MAIN',
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });

    // Seed a prior run's report on the LINKED issue (BRIG-SIB), declaring branch+PR.
    const [siblingTicket] = await db.db
      .insert(schema.tickets)
      .values({ workspaceId: p.workspaceId, jiraKey: 'BRIG-SIB', jiraId: '20001', summary: 'Sibling ticket' })
      .returning({ id: schema.tickets.id });
    await db.db.insert(schema.runs).values({
      workspaceId: p.workspaceId,
      ticketId: siblingTicket.id,
      agentId: p.agentId,
      executorType: 'claude_cli',
      status: 'succeeded',
      attempt: 1,
      report: {
        schema_version: 1,
        outcome: 'success',
        summary: 'Shipped the sibling change.',
        checks: [],
        artifacts: { branch: 'feat/BRIG-SIB', pr_url: 'https://github.com/acme/repo/pull/7' },
      },
    });

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'Implemented BRIG-MAIN.', checks: [] },
      },
    ]);

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId, TERMINAL);
    expect(row.status).toBe('succeeded');
    expect(row.worktreePath).toBeTruthy(); // kept (keepFailedWorktrees + callback-wired runFailed() quirk)

    const wrapperText = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapperText).toContain('## Feature context');
    expect(wrapperText).toContain('Epic: BRIG-EPIC [In Progress]');
    expect(wrapperText).toContain('BRIG-SIB [Code Review]');
    expect(wrapperText).toContain('branch: feat/BRIG-SIB');
    expect(wrapperText).toContain('PR: https://github.com/acme/repo/pull/7');
  }, 60_000);

  it('wrapper carries the ticket description fetched from Jira, converted ADF → markdown', async () => {
    mock.seedIssue('BRIG-DESC', {
      status: 'Ready for Dev',
      summary: 'Ticket with a body',
      description: {
        version: 1,
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Expected Behavior' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Output must be ' },
              { type: 'text', text: 'confirmation-gated', marks: [{ type: 'strong' }] },
              { type: 'text', text: '.' },
            ],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no processingTime in output' }] }],
              },
            ],
          },
          { type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: '{ "linkedFlags": [] }' }] },
        ],
      },
    });

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, keepFailedWorktrees: true }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'], branch_prefix: 'feat' },
      ticketKey: 'BRIG-DESC',
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'Implemented BRIG-DESC.', checks: [] },
      },
    ]);

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId, TERMINAL);
    expect(row.status).toBe('succeeded');

    const wrapperText = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    // The markdown body sits right under the ticket title line (wrapper.ts).
    expect(wrapperText).toContain('## Expected Behavior');
    expect(wrapperText).toContain('Output must be **confirmation-gated**.');
    expect(wrapperText).toContain('- no processingTime in output');
    expect(wrapperText).toContain('```json\n{ "linkedFlags": [] }\n```');
  }, 60_000);

  it('a failed description fetch falls back to an empty description without failing the run', async () => {
    mock.seedIssue('BRIG-D500', {
      status: 'Ready for Dev',
      summary: 'Ticket whose body fetch 500s',
      description: {
        version: 1,
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'MUST-NOT-APPEAR-IN-WRAPPER' }] }],
      },
    });

    const p = await seedPipeline(db.db, {
      executorType: 'claude_cli',
      executorConfig: baseExecutorConfig(env, { useCallbackChannel: true, keepFailedWorktrees: true }),
      behavior: { allowed_tools: ['Read', 'Edit', 'Bash(git *)'], branch_prefix: 'feat' },
      ticketKey: 'BRIG-D500',
      jiraSiteUrl: BASE,
      jiraCredentials: encodeJiraCredentials({ email: 'bot@acme.io', api_token: 'tok' }),
    });

    resetFakeClaudeEnv();
    setFakeClaudeCallbacks([
      {
        tool: 'complete',
        body: { schema_version: 1, outcome: 'success', summary: 'Implemented BRIG-D500.', checks: [] },
      },
    ]);

    // One-shot 500 on the next GET /issue: the agent has no statusRunning, so
    // onRunStarted performs no transition discovery — the armed 500 is consumed
    // by the description fetch itself, not by an unrelated issue GET.
    mock.arm500OnNextIssueGet();

    const res = await trigger.trigger({
      ticketId: p.ticketId,
      agentId: p.agentId,
      triggerEvent: { source: 'manual' },
    });
    if (res.deduplicated) throw new Error('unexpected dedup');

    const row = await pollRun(res.runId, TERMINAL);
    expect(row.status).toBe('succeeded'); // fetch failure never fails the job
    expect(row.attempt).toBe(1); // and never burns an attempt

    const wrapperText = await readFile(join(row.worktreePath!, '.brigadir', 'wrapper.txt'), 'utf8');
    expect(wrapperText).toContain('BRIG-D500');
    expect(wrapperText).not.toContain('MUST-NOT-APPEAR-IN-WRAPPER');
  }, 60_000);
});
