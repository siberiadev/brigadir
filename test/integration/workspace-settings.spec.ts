import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getWorkspaceSettings,
  getReconcileState,
  setReconcileState,
  getScopeJql,
  patchWorkspaceSettings,
} from '@brigadir/database';
import { startDatabase, DbHarness, seedPipeline } from './harness';

/**
 * T039: typed workspaces.settings accessors round-trip HWM / active_sprint_id /
 * scope_jql through the jsonb blob; absent fields return defaults.
 */
describe('workspace settings accessors (T039)', () => {
  let h: DbHarness;
  let workspaceId: string;

  beforeAll(async () => {
    h = await startDatabase();
    ({ workspaceId } = await seedPipeline(h.db));
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('returns defaults for an empty settings blob', async () => {
    expect(await getWorkspaceSettings(h.db, workspaceId)).toEqual({});
    expect(await getScopeJql(h.db, workspaceId)).toBeUndefined();
    expect(await getReconcileState(h.db, workspaceId)).toEqual({
      highWaterMark: undefined,
      activeSprintId: undefined,
    });
  });

  it('round-trips scope_jql + reconcile state and merges partial writes', async () => {
    await patchWorkspaceSettings(h.db, workspaceId, { scope_jql: 'labels = ai-pipeline' });
    await setReconcileState(h.db, workspaceId, {
      highWaterMark: '2026-07-11T09:12:33.000Z',
      activeSprintId: 4123,
    });

    expect(await getScopeJql(h.db, workspaceId)).toBe('labels = ai-pipeline');
    expect(await getReconcileState(h.db, workspaceId)).toEqual({
      highWaterMark: '2026-07-11T09:12:33.000Z',
      activeSprintId: 4123,
    });

    // partial write: advancing HWM must preserve active_sprint_id and scope_jql
    await setReconcileState(h.db, workspaceId, { highWaterMark: '2026-07-11T10:00:00.000Z' });
    const s = await getWorkspaceSettings(h.db, workspaceId);
    expect(s.scope_jql).toBe('labels = ai-pipeline');
    expect(s.reconcile).toEqual({
      high_water_mark: '2026-07-11T10:00:00.000Z',
      active_sprint_id: 4123,
    });
  });
});
