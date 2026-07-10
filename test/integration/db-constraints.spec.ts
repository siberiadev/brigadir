import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { startDatabase, seedPipeline, DbHarness, SeededPipeline } from './harness';

const ACTIVE = ['queued', 'running', 'awaiting_human'];

describe('runs_one_active partial unique index (T014)', () => {
  let h: DbHarness;
  let p: SeededPipeline;

  beforeAll(async () => {
    h = await startDatabase();
    p = await seedPipeline(h.db);
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

  it('allows a new active run once the prior run reaches a terminal state', async () => {
    // move the single active run to a terminal state
    await h.db
      .update(schema.runs)
      .set({ status: 'succeeded', finishedAt: sql`now()` })
      .where(and(eq(schema.runs.ticketId, p.ticketId), inArray(schema.runs.status, ACTIVE)));

    await expect(insertActiveRun()).resolves.toBeUndefined();

    const active = await h.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, p.ticketId), inArray(schema.runs.status, ACTIVE)));
    expect(active).toHaveLength(1);
  });
});
