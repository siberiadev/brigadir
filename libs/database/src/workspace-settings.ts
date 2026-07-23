import { eq, sql } from 'drizzle-orm';
import {
  WorkspaceSettingsSchema,
  type WorkspaceSettings,
  type WorkspaceRepository,
  type AgentInstructionsSource,
} from '@brigadir/contracts';
import type { BrigadirDb } from './drizzle.constants';
import * as schema from './schema';

/**
 * Typed accessors for the `workspaces.settings` jsonb blob (T039, data-model.md).
 *
 * scope_jql, the reconciliation high-water mark, and the last-seen active sprint
 * id all live in this blob — NOT in dedicated columns (architecture §3). These
 * helpers validate the blob against WorkspaceSettingsSchema and merge-write it,
 * so callers never touch jsonb ad hoc.
 */

type Db = Pick<BrigadirDb, 'select' | 'update'>;

export async function getWorkspaceSettings(db: Db, workspaceId: string): Promise<WorkspaceSettings> {
  const [row] = await db
    .select({ settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!row) throw new Error(`workspace ${workspaceId} not found`);
  return WorkspaceSettingsSchema.parse(row.settings ?? {});
}

/** Shallow-merge a partial patch into settings and persist (bumps updated_at). */
export async function patchWorkspaceSettings(
  db: Db,
  workspaceId: string,
  patch: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettings> {
  const current = await getWorkspaceSettings(db, workspaceId);
  const next = WorkspaceSettingsSchema.parse({ ...current, ...patch });
  await db
    .update(schema.workspaces)
    .set({ settings: next, updatedAt: sql`now()` })
    .where(eq(schema.workspaces.id, workspaceId));
  return next;
}

export async function getScopeJql(db: Db, workspaceId: string): Promise<string | undefined> {
  return (await getWorkspaceSettings(db, workspaceId)).scope_jql;
}

// --- feature 030: agent role-template source (workspace level) ---

/** A workspace's non-secret template-source config + its sealed token blob (if any). */
export interface StoredInstructionSource {
  source: AgentInstructionsSource | null;
  /** Sealed envelope bytes (opened by the resolver, never here); null = no token. */
  tokenBlob: Buffer | null;
}

type DbRead = Pick<BrigadirDb, 'select'>;
type DbWrite = Pick<BrigadirDb, 'select' | 'update'>;

/**
 * Read a workspace's template-source OVERRIDE: `settings.agent_instructions`
 * plus the sealed `agent_instructions_token` bytea. Both absent ⇒ this
 * workspace has no override (the resolver falls back to the global source).
 */
export async function getWorkspaceInstructionSource(
  db: DbRead,
  workspaceId: string,
): Promise<StoredInstructionSource> {
  const [row] = await db
    .select({
      settings: schema.workspaces.settings,
      token: schema.workspaces.agentInstructionsToken,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!row) return { source: null, tokenBlob: null };
  const settings = WorkspaceSettingsSchema.parse(row.settings ?? {});
  return {
    source: settings.agent_instructions ?? null,
    tokenBlob: row.token ? Buffer.from(row.token) : null,
  };
}

/** Set or clear (`null`) the workspace's template-source config in the settings blob. */
export async function setWorkspaceInstructionSource(
  db: DbWrite,
  workspaceId: string,
  source: AgentInstructionsSource | null,
): Promise<void> {
  const current = await getWorkspaceSettings(db, workspaceId);
  const next = { ...current };
  if (source === null) delete next.agent_instructions;
  else next.agent_instructions = source;
  await db
    .update(schema.workspaces)
    .set({ settings: WorkspaceSettingsSchema.parse(next), updatedAt: sql`now()` })
    .where(eq(schema.workspaces.id, workspaceId));
}

/** Set or clear (`null`) the workspace's sealed template-repo token column. */
export async function setWorkspaceInstructionToken(
  db: Pick<BrigadirDb, 'update'>,
  workspaceId: string,
  tokenBlob: Buffer | null,
): Promise<void> {
  await db
    .update(schema.workspaces)
    .set({ agentInstructionsToken: tokenBlob, updatedAt: sql`now()` })
    .where(eq(schema.workspaces.id, workspaceId));
}

/** Default rework-cycle budget when `workspaces.settings.rework_max` is unset (feature 010, FR-006). */
export const DEFAULT_REWORK_MAX = 2;

/**
 * The workspace's rework-cycle budget (feature 010, FR-006/D3): how many
 * `source='rework'` runs a ticket may accumulate before the loop is capped and
 * escalated to a human. Absent settings key ⇒ {@link DEFAULT_REWORK_MAX} (2).
 */
export async function getReworkMax(db: Db, workspaceId: string): Promise<number> {
  return (await getWorkspaceSettings(db, workspaceId)).rework_max ?? DEFAULT_REWORK_MAX;
}

/**
 * Whether ticket repository scoping via Jira Components is enabled for the
 * workspace (feature 020, D2b). Absent settings key ⇒ false (OFF) — narrowing
 * and the fail-closed gate never apply. The executor reads the flag off the
 * settings row it already loads at repository resolution; this accessor exists
 * for backend/tests.
 */
export async function getTicketScoping(db: Db, workspaceId: string): Promise<boolean> {
  return (await getWorkspaceSettings(db, workspaceId)).ticket_scoping === true;
}

/**
 * The workspace's ordered repository list (feature 005; first = default). An
 * absent/empty `repositories` blob yields `[]`.
 */
export async function getRepositories(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceRepository[]> {
  return (await getWorkspaceSettings(db, workspaceId)).repositories ?? [];
}

export interface ReconcileState {
  highWaterMark?: string;
  /** The last-seen active sprint set (FR-032). Empty array = none active. */
  activeSprintIds?: number[];
}

export async function getReconcileState(db: Db, workspaceId: string): Promise<ReconcileState> {
  const s = await getWorkspaceSettings(db, workspaceId);
  // Read-compat: prefer the new array; fall back to the legacy single id so a
  // pre-existing blob keeps its sprint-switch state across the upgrade.
  const ids =
    s.reconcile?.active_sprint_ids ??
    (s.reconcile?.active_sprint_id != null ? [s.reconcile.active_sprint_id] : undefined);
  return {
    highWaterMark: s.reconcile?.high_water_mark,
    activeSprintIds: ids,
  };
}

/**
 * Normalize any parseable timestamp to UTC ISO (`...Z`). Real Jira emits
 * `updated` with a numeric offset (`2026-07-12T14:03:21.123+0300`), which the
 * strict `z.string().datetime()` in WorkspaceSettingsSchema rejects — found
 * live at the iteration-5 acceptance (mock-jira always emitted `Z`, hiding it).
 * The HWM is stored in ONE canonical form so schema stays strict and JQL
 * `sinceClause` math never has to reason about offsets.
 */
function toUtcIso(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`setReconcileState: high_water_mark is not a parseable timestamp: "${value}"`);
  }
  return new Date(ms).toISOString();
}

/** Merge-write the reconcile sub-object, preserving whichever field is omitted. */
export async function setReconcileState(
  db: Db,
  workspaceId: string,
  patch: ReconcileState,
): Promise<void> {
  const current = await getWorkspaceSettings(db, workspaceId);
  const reconcile = {
    high_water_mark: patch.highWaterMark
      ? toUtcIso(patch.highWaterMark)
      : current.reconcile?.high_water_mark,
    // New writes use the array. Preserve the prior set when the patch omits it.
    // Drop the legacy scalar on any write so the two never diverge (getReconcileState
    // reads the array first, so a cleared array wins).
    active_sprint_ids:
      patch.activeSprintIds !== undefined
        ? patch.activeSprintIds
        : (current.reconcile?.active_sprint_ids ??
          (current.reconcile?.active_sprint_id != null ? [current.reconcile.active_sprint_id] : undefined)),
  };
  await patchWorkspaceSettings(db, workspaceId, { reconcile });
}
