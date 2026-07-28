import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@brigadir/database';
import { startDatabase, seedPipeline, DbHarness, SeededPipeline } from './harness';

/**
 * SXF-1174 Problem 6 — migration 0011 tightens `runs_one_active` from
 * (ticket_id, agent_id) to (ticket_id) and DEMOTES pre-existing cross-agent
 * duplicate active runs (the incident state) before creating the index.
 *
 * `startDatabase()` applies the whole committed chain (0000..0011) on a fresh
 * Postgres, so reaching this suite already proves the chain applies from
 * scratch. The demotion itself cannot be exercised through the chain (a fresh
 * DB has no duplicates), so this suite reconstructs the exact pre-0011 index
 * shape, seeds the duplicate state, and replays the COMMITTED migration SQL.
 */
describe('migration 0011_one_active_per_ticket — demotion + per-ticket uniqueness', () => {
  let h: DbHarness;
  let p: SeededPipeline;
  let agentBId: string;
  let controlTicketId: string;

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
    agentBId = agentB.id;

    const [controlTicket] = await h.db
      .insert(schema.tickets)
      .values({ workspaceId: p.workspaceId, jiraKey: 'BRIG-CTRL', jiraId: '10001', summary: 'control' })
      .returning({ id: schema.tickets.id });
    controlTicketId = controlTicket.id;
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('demotes cross-agent duplicates (keeping awaiting_human), leaves singles alone, and enforces per-ticket uniqueness', async () => {
    // 1. Reconstruct the exact pre-0011 index shape (0000_init) so duplicate
    //    actives are insertable again.
    await h.db.execute(sql`DROP INDEX "runs_one_active"`);
    await h.db.execute(
      sql`CREATE UNIQUE INDEX "runs_one_active" ON "runs" USING btree ("ticket_id","agent_id") WHERE status IN ('queued', 'running', 'awaiting_human')`,
    );

    // 2. Seed the incident state: two active runs (different agents) on one
    //    ticket — an OLDER queued run (agent A) and a NEWER awaiting_human run
    //    (agent B) — plus a single running run on a control ticket.
    const [olderQueued] = await h.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'queued',
        createdAt: sql`now() - interval '2 hours'`,
      })
      .returning({ id: schema.runs.id });
    const [newerParked] = await h.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: agentBId,
        executorType: 'mock',
        status: 'awaiting_human',
        createdAt: sql`now() - interval '1 hour'`,
      })
      .returning({ id: schema.runs.id });
    const [control] = await h.db
      .insert(schema.runs)
      .values({
        workspaceId: p.workspaceId,
        ticketId: controlTicketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'running',
      })
      .returning({ id: schema.runs.id });

    // 3. Replay the COMMITTED migration SQL, statement by statement.
    const migrationSql = readFileSync(
      join(process.cwd(), 'drizzle', '0011_one_active_per_ticket.sql'),
      'utf8',
    );
    for (const statement of migrationSql.split('--> statement-breakpoint')) {
      await h.db.execute(sql.raw(statement));
    }

    // 4. Demotion choice: the awaiting_human run survives (its open blocking
    //    human task stays resumable), the older queued run is cancelled.
    const statusOf = async (id: string) => {
      const [r] = await h.db
        .select({ status: schema.runs.status, finishedAt: schema.runs.finishedAt })
        .from(schema.runs)
        .where(eq(schema.runs.id, id));
      return r;
    };
    expect((await statusOf(newerParked.id)).status).toBe('awaiting_human');
    const demoted = await statusOf(olderQueued.id);
    expect(demoted.status).toBe('cancelled');
    expect(demoted.finishedAt).not.toBeNull();
    // The control ticket's single active run is untouched.
    expect((await statusOf(control.id)).status).toBe('running');

    // 5. The new index is per-ticket: any agent's active insert on the
    //    occupied ticket now rejects with 23505.
    let code: string | undefined;
    try {
      await h.db.insert(schema.runs).values({
        workspaceId: p.workspaceId,
        ticketId: p.ticketId,
        agentId: p.agentId,
        executorType: 'mock',
        status: 'queued',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('23505');

    // 6. Index shape probe: single-column partial unique on ticket_id.
    const idx = await h.db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'runs_one_active'
    `);
    const def = String(idx.rows[0]?.indexdef ?? '');
    expect(def).toContain('(ticket_id)');
    expect(def).not.toContain('agent_id');
  });
});
