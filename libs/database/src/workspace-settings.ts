import { eq, sql } from 'drizzle-orm';
import { WorkspaceSettingsSchema, type WorkspaceSettings } from '@brigadir/contracts';
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

export interface ReconcileState {
  highWaterMark?: string;
  activeSprintId?: number | null;
}

export async function getReconcileState(db: Db, workspaceId: string): Promise<ReconcileState> {
  const s = await getWorkspaceSettings(db, workspaceId);
  return {
    highWaterMark: s.reconcile?.high_water_mark,
    activeSprintId: s.reconcile?.active_sprint_id,
  };
}

/** Merge-write the reconcile sub-object, preserving whichever field is omitted. */
export async function setReconcileState(
  db: Db,
  workspaceId: string,
  patch: ReconcileState,
): Promise<void> {
  const current = await getWorkspaceSettings(db, workspaceId);
  const reconcile = {
    high_water_mark: patch.highWaterMark ?? current.reconcile?.high_water_mark,
    active_sprint_id:
      patch.activeSprintId !== undefined ? patch.activeSprintId : current.reconcile?.active_sprint_id,
  };
  await patchWorkspaceSettings(db, workspaceId, { reconcile });
}
