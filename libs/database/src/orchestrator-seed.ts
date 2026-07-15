import { and, eq } from 'drizzle-orm';
import type { BrigadirDb } from './drizzle.constants';
import * as schema from './schema';

/**
 * Orchestrator ("brigadir") seeding (feature 010, FR-018/022, D2/D10). The
 * orchestrator is an ordinary `agents` row marked `is_orchestrator=true`, never
 * poll-triggered, on a dedicated CHEAP, NO-REPOSITORY executor profile (its
 * triage runs read only the system's own run history — no repo, no git creds,
 * Constitution V). Seeding is insert-if-absent (UNIQUE(workspace_id, name)) so
 * it runs safely on every boot and never overwrites operator edits.
 */

export const ORCHESTRATOR_AGENT_NAME = 'brigadir';

/** The dedicated cheap, no-repository executor profile the orchestrator runs on. */
export const ORCHESTRATOR_EXECUTOR_NAME = 'brigadir-orchestrator';

/**
 * Inert placeholder for the orchestrator's success/failure statuses. They are
 * NOT NULL in §3 but never used — a completed orchestrator run takes NO generic
 * transition (FR-007), so this value is never sent to Jira. A visibly-inert
 * dash (not a real board status like "Blocked") so it cannot be mistaken for a
 * configured mapping anywhere the row is displayed.
 */
const ORCHESTRATOR_INERT_STATUS = '—';

/**
 * Built-in default orchestrator instruction (FR-022) — copied into a workspace's
 * seeded orchestrator when `global_settings.default_orchestrator_instruction`
 * is unset. The routing protocol + roster arrive per-run via the handoff
 * section (FR-012), so this stays a short role prompt.
 */
export const DEFAULT_ORCHESTRATOR_INSTRUCTION = `You are "brigadir", the triage orchestrator for this workspace.

A worker agent's run has failed on a ticket. Your job is to read the failing run's report and the roster of available worker agents (both provided in the handoff section of this prompt) and decide, deterministically and briefly, how to proceed:

- If a worker agent can fix the problem, reply with the "routed" outcome, naming the target agent and writing a self-contained rework task (framed as a fix of existing work — the worker continues on the existing branch/PR).
- If the failure needs a human (ambiguous requirements, a product decision, repeated failures), reply with the "needs_human" outcome.

Do not attempt to fix the code yourself — you have no repository. Do not exceed the rework budget; the system enforces it. Keep the rework task concrete and actionable.`;

const ORCHESTRATOR_KEY = 'default_orchestrator_instruction';

/** Read the current default orchestrator instruction, falling back to the built-in constant. */
export async function getDefaultOrchestratorInstruction(db: BrigadirDb): Promise<string> {
  const [row] = await db
    .select({ value: schema.globalSettings.value })
    .from(schema.globalSettings)
    .where(eq(schema.globalSettings.key, ORCHESTRATOR_KEY))
    .limit(1);
  const value = row?.value;
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_ORCHESTRATOR_INSTRUCTION;
}

/** The cheap, no-repository executor profile config (claude_cli). */
function orchestratorExecutorValues() {
  return {
    name: ORCHESTRATOR_EXECUTOR_NAME,
    type: 'claude_cli',
    maxParallelRuns: 2,
    config: {
      // Cheapest capable model — triage is a short reasoning turn.
      model: 'claude-haiku-4-5-20251001',
      cliPath: 'claude',
      useCallbackChannel: true,
      // No repository workspace (FR-018, Constitution V): triage reads only the
      // system's own run history; the executor skips clone/worktree preparation.
      workspaceMode: 'none',
      maxTurns: 15,
    },
  };
}

/**
 * Ensure the dedicated orchestrator executor profile exists (insert-if-absent on
 * the GLOBAL executor name). Returns its id.
 */
export async function ensureOrchestratorExecutor(db: BrigadirDb): Promise<string> {
  const [existing] = await db
    .select({ id: schema.executors.id })
    .from(schema.executors)
    .where(eq(schema.executors.name, ORCHESTRATOR_EXECUTOR_NAME))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(schema.executors)
    .values(orchestratorExecutorValues())
    .onConflictDoNothing({ target: schema.executors.name })
    .returning({ id: schema.executors.id });
  if (row) return row.id;

  // Lost an insert race — read the winner.
  const [winner] = await db
    .select({ id: schema.executors.id })
    .from(schema.executors)
    .where(eq(schema.executors.name, ORCHESTRATOR_EXECUTOR_NAME))
    .limit(1);
  return winner.id;
}

export interface SeedOrchestratorResult {
  created: boolean;
  agentId: string;
}

/**
 * Insert the per-workspace orchestrator if absent (FR-018). Never overwrites an
 * existing "brigadir" row — instruction/enabled edits are the operator's.
 */
export async function seedOrchestratorAgent(
  db: BrigadirDb,
  workspaceId: string,
): Promise<SeedOrchestratorResult> {
  const [existing] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.name, ORCHESTRATOR_AGENT_NAME),
      ),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.id };

  const executorId = await ensureOrchestratorExecutor(db);
  const instruction = await getDefaultOrchestratorInstruction(db);

  const [row] = await db
    .insert(schema.agents)
    .values({
      workspaceId,
      executorId,
      name: ORCHESTRATOR_AGENT_NAME,
      instruction,
      isOrchestrator: true,
      triggerStatus: null,
      triggerJql: null,
      statusRunning: null,
      statusSuccess: ORCHESTRATOR_INERT_STATUS,
      statusFailure: ORCHESTRATOR_INERT_STATUS,
      behavior: { workspace_mode: 'none' },
      enabled: true,
    })
    .onConflictDoNothing({ target: [schema.agents.workspaceId, schema.agents.name] })
    .returning({ id: schema.agents.id });

  if (row) return { created: true, agentId: row.id };

  // Lost an insert race — return the winning row.
  const [winner] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.name, ORCHESTRATOR_AGENT_NAME),
      ),
    )
    .limit(1);
  return { created: false, agentId: winner.id };
}
