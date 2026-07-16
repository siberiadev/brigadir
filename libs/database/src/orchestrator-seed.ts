import { and, eq } from 'drizzle-orm';
import {
  ORCHESTRATOR_AGENT_KEY,
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
  WORKSPACE_SETUP_INSTRUCTION_KEY,
} from '@brigadir/contracts';
import type { BrigadirDb } from './drizzle.constants';
import * as schema from './schema';

/**
 * Orchestrator ("brigadir") seeding (feature 010, FR-018/022, D2/D10). The
 * orchestrator is an ordinary `agents` row marked `is_orchestrator=true`, never
 * poll-triggered, on a dedicated CHEAP, NO-REPOSITORY executor profile (its
 * triage runs read only the system's own run history — no repo, no git creds,
 * Constitution V). Seeding is insert-if-absent (identity = is_orchestrator flag /
 * UNIQUE(workspace_id, key), feature 014) so it runs safely on every boot and
 * never overwrites operator edits.
 */

/** Default persona name of the orchestrator (editable like any agent, feature 014). */
export const ORCHESTRATOR_AGENT_NAME = 'brigadir';

/** feature 014: the orchestrator's function; carries no system meaning (the flag does). */
export const ORCHESTRATOR_AGENT_ROLE = 'teamlead';

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
 * Built-in default instruction texts (FR-022) live in `@brigadir/contracts`
 * (orchestrator-defaults.ts) since 2026-07-16 so the web app can offer
 * "Reset to default" without a server round-trip. Re-exported here to keep
 * the historical `@brigadir/database` import path working.
 */
export { DEFAULT_ORCHESTRATOR_INSTRUCTION, DEFAULT_WORKSPACE_SETUP_INSTRUCTION };

/** Read one global_settings text value, falling back to the built-in default. */
async function getInstructionSetting(
  db: BrigadirDb,
  key: string,
  fallback: string,
): Promise<string> {
  const [row] = await db
    .select({ value: schema.globalSettings.value })
    .from(schema.globalSettings)
    .where(eq(schema.globalSettings.key, key))
    .limit(1);
  const value = row?.value;
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Read the current default orchestrator (routing) instruction, falling back to the built-in constant. */
export async function getDefaultOrchestratorInstruction(db: BrigadirDb): Promise<string> {
  return getInstructionSetting(
    db,
    DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
    DEFAULT_ORCHESTRATOR_INSTRUCTION,
  );
}

/**
 * Read the current agent-creation (workspace setup) instruction, falling back
 * to the built-in constant. Unlike the routing instruction (copied into the
 * agent at workspace creation), this one is read LIVE by the setup handoff on
 * every generate-agents run — edits apply to the very next run.
 */
export async function getWorkspaceSetupInstruction(db: BrigadirDb): Promise<string> {
  return getInstructionSetting(
    db,
    WORKSPACE_SETUP_INSTRUCTION_KEY,
    DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  );
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
        eq(schema.agents.isOrchestrator, true),
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
      role: ORCHESTRATOR_AGENT_ROLE,
      // feature 014: reserved key; no worker can obtain it (ensureUniqueAgentKey).
      key: ORCHESTRATOR_AGENT_KEY,
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
    .onConflictDoNothing({ target: [schema.agents.workspaceId, schema.agents.key] })
    .returning({ id: schema.agents.id });

  if (row) return { created: true, agentId: row.id };

  // Lost an insert race — return the winning row.
  const [winner] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.isOrchestrator, true),
      ),
    )
    .limit(1);
  return { created: false, agentId: winner.id };
}
