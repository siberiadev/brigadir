import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { startDatabase, seedPipeline, DbHarness, SeededPipeline } from './harness';

const ACTIVE = ['queued', 'running', 'awaiting_human'];

describe('runs_one_active partial unique index — one active run per TICKET (T014 + SXF-1174 Problem 6)', () => {
  let h: DbHarness;
  let p: SeededPipeline;
  let secondAgentId: string;

  beforeAll(async () => {
    h = await startDatabase();
    p = await seedPipeline(h.db);
    const [agentB] = await h.db
      .insert(schema.agents)
      .values({
        workspaceId: p.workspaceId,
        executorId: p.executorId,
        name: 'implementer-b',
        key: 'implementer-b',
        instruction: 'Second agent.',
        statusSuccess: 'Code Review',
        statusFailure: 'Blocked',
        maxAttempts: 2,
        behavior: {},
      })
      .returning({ id: schema.agents.id });
    secondAgentId = agentB.id;
  });

  afterAll(async () => {
    await h?.stop();
  });

  async function insertActiveRun(status = 'queued'): Promise<void> {
    await h.db.insert(schema.runs).values({
      workspaceId: p.workspaceId,
      ticketId: p.ticketId,
      agentId: p.agentId,
      executorType: 'mock',
      status,
    });
  }

  it('permits exactly one active run per (ticket, agent) under a concurrent race', async () => {
    const results = await Promise.allSettled([insertActiveRun(), insertActiveRun()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Postgres unique_violation
    expect((rejected[0].reason as { code?: string }).code).toBe('23505');

    const active = await h.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, p.ticketId), inArray(schema.runs.status, ACTIVE)));
    expect(active).toHaveLength(1);
  });

  it('rejects an active run for a DIFFERENT agent on the same ticket (SXF-1174 Problem 6)', async () => {
    // The previous test left one active run (agent A) on the ticket.
    let code: string | undefined;
    try {
      await h.db.insert(schema.runs).values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: secondAgentId,
        executorType: 'mock',
        status: 'queued',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('23505');
  });

  it('allows a new active run once the prior run reaches a terminal state', async () => {
    // move the single active run to a terminal state
    await h.db
      .update(schema.runs)
      .set({ status: 'succeeded', finishedAt: sql`now()` })
      .where(and(eq(schema.runs.ticketId, p.ticketId), inArray(schema.runs.status, ACTIVE)));

    // The freed per-ticket slot is claimable by ANY agent — here the second one.
    await expect(
      h.db
        .insert(schema.runs)
        .values({
          workspaceId: p.workspaceId,
          ticketId: p.ticketId,
          agentId: secondAgentId,
          executorType: 'mock',
          status: 'queued',
        })
        .then(() => undefined),
    ).resolves.toBeUndefined();

    const active = await h.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, p.ticketId), inArray(schema.runs.status, ACTIVE)));
    expect(active).toHaveLength(1);
  });
});

describe('runs_one_active_setup partial unique index + nullable tickets (feature 011, T006)', () => {
  let h: DbHarness;
  let p: SeededPipeline;

  beforeAll(async () => {
    h = await startDatabase();
    p = await seedPipeline(h.db);
  });

  afterAll(async () => {
    await h?.stop();
  });

  async function insertSetupRun(status = 'queued'): Promise<void> {
    await h.db.insert(schema.runs).values({
      workspaceId: p.workspaceId,
      ticketId: null,
      agentId: p.agentId,
      executorType: 'mock',
      status,
      triggerEvent: { source: 'workspace-setup' },
    });
  }

  it('accepts ticketless rows on runs and human_tasks', async () => {
    await expect(insertSetupRun('succeeded')).resolves.toBeUndefined();
    await expect(
      h.db.insert(schema.humanTasks).values({
        workspaceId: p.workspaceId,
        ticketId: null,
        kind: 'review',
        title: 'Team assembled — review the workspace',
        blocking: false,
        status: 'open',
      }),
    ).resolves.toBeDefined();
  });

  it('permits exactly one ACTIVE ticketless run per workspace under a concurrent race', async () => {
    const results = await Promise.allSettled([insertSetupRun(), insertSetupRun()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('23505');
  });

  it('does not let ticketless rows interfere with the ticketed guard (and vice versa)', async () => {
    // An active TICKETED run coexists with the active ticketless one.
    await expect(
      h.db.insert(schema.runs).values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'queued',
      }),
    ).resolves.toBeDefined();
  });

  it('allows a new setup run once the prior one is terminal', async () => {
    await h.db
      .update(schema.runs)
      .set({ status: 'failed', finishedAt: sql`now()` })
      .where(
        and(
          eq(schema.runs.workspaceId, p.workspaceId),
          sql`${schema.runs.ticketId} IS NULL`,
          inArray(schema.runs.status, ACTIVE),
        ),
      );
    await expect(insertSetupRun()).resolves.toBeUndefined();
  });
});
