import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { RunTriggerService } from '@brigadir/runs';
import { MOCK_SCENARIOS, type MockScenario } from '@brigadir/contracts';
import { SmokeModule } from './smoke.module';

const TERMINAL = ['succeeded', 'failed', 'timed_out', 'cancelled', 'awaiting_human'];

function parseScenario(): MockScenario {
  const idx = process.argv.indexOf('--scenario');
  const value = idx >= 0 ? process.argv[idx + 1] : 'success';
  if (!MOCK_SCENARIOS.includes(value as MockScenario)) {
    throw new Error(`unknown --scenario "${value}" (one of: ${MOCK_SCENARIOS.join(', ')})`);
  }
  return value as MockScenario;
}

async function main(): Promise<void> {
  const scenario = parseScenario();
  const app = await NestFactory.createApplicationContext(SmokeModule, { bufferLogs: false });
  const db = app.get<BrigadirDb>(DRIZZLE);
  const trigger = app.get(RunTriggerService);

  const [ws] = await db.select().from(schema.workspaces).limit(1);
  if (!ws) throw new Error('no workspace seeded — start the backend (which seeds from agents.yaml) first');
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, ws.id))
    .limit(1);
  if (!agent) throw new Error('no agent seeded');

  const [ticket] = await db
    .insert(schema.tickets)
    .values({ workspaceId: ws.id, jiraKey: 'SMOKE-1', jiraId: 'smoke-1', summary: 'Smoke ticket' })
    .onConflictDoUpdate({
      target: [schema.tickets.workspaceId, schema.tickets.jiraKey],
      set: { summary: 'Smoke ticket' },
    })
    .returning({ id: schema.tickets.id });

  const res = await trigger.trigger({
    ticketId: ticket.id,
    agentId: agent.id,
    triggerEvent: { source: 'manual', mock_scenario: scenario, rate_limit_ttl_ms: 200 },
  });
  const runId = res.deduplicated ? res.existingRunId : res.runId;
  process.stdout.write(`[smoke] scenario=${scenario} → ${JSON.stringify(res)}\n`);

  const deadline = Date.now() + 30_000;
  let row: { status: string; attempt: number; outcome: string | null } | undefined;
  while (Date.now() < deadline) {
    [row] = await db
      .select({ status: schema.runs.status, attempt: schema.runs.attempt, outcome: schema.runs.outcome })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId!))
      .limit(1);
    if (row && TERMINAL.includes(row.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  process.stdout.write(`[smoke] run ${runId}: ${JSON.stringify(row)}\n`);
  await app.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[smoke] fatal: ${message}\n`);
  process.exit(1);
});
