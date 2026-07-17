import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  ORCHESTRATOR_AGENT_KEY,
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  DEFAULT_ORCHESTRATOR_INSTRUCTION_KEY,
  WORKSPACE_SETUP_INSTRUCTION_KEY,
  BRIGADIR_AGENT_TEMPLATE_KEY,
  BrigadirAgentTemplateSchema,
  DEFAULT_BRIGADIR_AGENT_TEMPLATE,
  type BrigadirAgentTemplate,
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

/** The dedicated cheap, no-repository executor profile the orchestrator's TRIAGE runs on. */
export const ORCHESTRATOR_EXECUTOR_NAME = 'brigadir-orchestrator';

/**
 * The built-in repo-mounted executor profile for workspace-SETUP runs
 * (feature 015, D9): capable model, large turn budget; also the fallback
 * target when the template's setup executor is missing or disabled (FR-018).
 */
export const SETUP_EXECUTOR_NAME: string = DEFAULT_BRIGADIR_AGENT_TEMPLATE.setup.executor;

const templateLogger = new Logger('brigadir-agent-template');

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

/**
 * Read the brigadir agent template (feature 015). One JSON document in the
 * global_settings KV; a missing key or a corrupt/schema-invalid value falls
 * back to the built-in default with a warning — reads never fail (FR-011).
 * NOT built on getInstructionSetting: that reader string-coerces jsonb values.
 */
export async function getBrigadirAgentTemplate(db: BrigadirDb): Promise<BrigadirAgentTemplate> {
  const [row] = await db
    .select({ value: schema.globalSettings.value })
    .from(schema.globalSettings)
    .where(eq(schema.globalSettings.key, BRIGADIR_AGENT_TEMPLATE_KEY))
    .limit(1);
  if (!row) return DEFAULT_BRIGADIR_AGENT_TEMPLATE;

  const parsed = BrigadirAgentTemplateSchema.safeParse(row.value);
  if (!parsed.success) {
    templateLogger.warn(
      `Stored ${BRIGADIR_AGENT_TEMPLATE_KEY} is corrupt (${parsed.error.issues[0]?.message ?? 'schema mismatch'}) — using built-in defaults`,
    );
    return DEFAULT_BRIGADIR_AGENT_TEMPLATE;
  }
  return parsed.data;
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

/** The repo-mounted workspace-setup executor profile config (claude_cli, feature 015 D9). */
function setupExecutorValues() {
  return {
    name: SETUP_EXECUTOR_NAME,
    type: 'claude_cli',
    // Setup runs are rare and human-initiated — one at a time is plenty.
    maxParallelRuns: 1,
    config: {
      // Capable workhorse tier: recon + team generation is one long reasoning task.
      model: 'claude-sonnet-5',
      cliPath: 'claude',
      useCallbackChannel: true,
      // No workspaceMode:'none' — setup runs mount the workspace default repo
      // (feature 015: the FR-018/Constitution-V "no repository" rule is
      // narrowed to TRIAGE runs; see plan.md Constitution Check).
      maxTurns: 60,
    },
  };
}

/**
 * Ensure the built-in workspace-setup executor profile exists (insert-if-absent
 * on the GLOBAL executor name). Returns its id. Mirrors ensureOrchestratorExecutor.
 */
export async function ensureSetupExecutor(db: BrigadirDb): Promise<string> {
  const [existing] = await db
    .select({ id: schema.executors.id })
    .from(schema.executors)
    .where(eq(schema.executors.name, SETUP_EXECUTOR_NAME))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(schema.executors)
    .values(setupExecutorValues())
    .onConflictDoNothing({ target: schema.executors.name })
    .returning({ id: schema.executors.id });
  if (row) return row.id;

  // Lost an insert race — read the winner.
  const [winner] = await db
    .select({ id: schema.executors.id })
    .from(schema.executors)
    .where(eq(schema.executors.name, SETUP_EXECUTOR_NAME))
    .limit(1);
  return winner.id;
}

export interface SeedOrchestratorResult {
  created: boolean;
  agentId: string;
  /**
   * Set when the template's triage executor was missing or disabled and the
   * orchestrator was seeded on the built-in profile instead (FR-010). The
   * wizard surfaces it as a response warning; seeder/backfill log it.
   */
  warning?: string;
}

/**
 * Resolve the template's triage executor PROFILE NAME to an id. Missing or
 * disabled profile → built-in fallback + warning; workspace creation never
 * fails on a dangling reference (FR-010). A missing reference to the built-in
 * name itself is a fresh-database case, not a misconfiguration — no warning.
 */
async function resolveTriageExecutor(
  db: BrigadirDb,
  template: BrigadirAgentTemplate,
): Promise<{ executorId: string; warning?: string }> {
  const name = template.triage.executor;
  const [profile] = await db
    .select({ id: schema.executors.id, enabled: schema.executors.enabled })
    .from(schema.executors)
    .where(eq(schema.executors.name, name))
    .limit(1);

  if (profile?.enabled) return { executorId: profile.id };
  if (!profile && name === ORCHESTRATOR_EXECUTOR_NAME) {
    return { executorId: await ensureOrchestratorExecutor(db) };
  }
  return {
    executorId: await ensureOrchestratorExecutor(db),
    warning: `Executor profile "${name}" ${profile ? 'is disabled' : 'does not exist'} — orchestrator seeded on "${ORCHESTRATOR_EXECUTOR_NAME}".`,
  };
}

/**
 * Insert the per-workspace orchestrator if absent (FR-018). Never overwrites an
 * existing "brigadir" row — instruction/enabled edits are the operator's.
 * Since feature 015 the seeded values come from the brigadir agent template
 * (copy-at-creation: template edits affect only workspaces created later).
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

  const template = await getBrigadirAgentTemplate(db);
  const { executorId, warning } = await resolveTriageExecutor(db, template);
  // The setup profile must exist for setup runs and settings validation alike;
  // seeded here (insert-if-absent) so every deployment path gets it.
  await ensureSetupExecutor(db);
  const instruction = await getDefaultOrchestratorInstruction(db);

  const [row] = await db
    .insert(schema.agents)
    .values({
      workspaceId,
      executorId,
      name: template.name,
      role: template.role,
      // feature 014: reserved key; no worker can obtain it (ensureUniqueAgentKey).
      key: ORCHESTRATOR_AGENT_KEY,
      instruction,
      isOrchestrator: true,
      triggerStatus: null,
      triggerJql: null,
      statusRunning: null,
      statusSuccess: ORCHESTRATOR_INERT_STATUS,
      statusFailure: ORCHESTRATOR_INERT_STATUS,
      behavior: template.triage.behavior,
      timeoutMinutes: template.timeout_minutes,
      maxBudgetUsd: template.max_budget_usd === null ? null : String(template.max_budget_usd),
      maxAttempts: template.max_attempts,
      enabled: template.enabled,
    })
    .onConflictDoNothing({ target: [schema.agents.workspaceId, schema.agents.key] })
    .returning({ id: schema.agents.id });

  if (row) return { created: true, agentId: row.id, warning };

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
