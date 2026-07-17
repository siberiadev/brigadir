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
      activeSprintIds: undefined,
    });
  });

  it('round-trips scope_jql + reconcile state (multi-sprint) and merges partial writes', async () => {
    await patchWorkspaceSettings(h.db, workspaceId, { scope_jql: 'labels = ai-pipeline' });
    await setReconcileState(h.db, workspaceId, {
      highWaterMark: '2026-07-11T09:12:33.000Z',
      activeSprintIds: [4123, 4124],
    });

    expect(await getScopeJql(h.db, workspaceId)).toBe('labels = ai-pipeline');
    expect(await getReconcileState(h.db, workspaceId)).toEqual({
      highWaterMark: '2026-07-11T09:12:33.000Z',
      activeSprintIds: [4123, 4124],
    });

    // partial write: advancing HWM must preserve active_sprint_ids and scope_jql
    await setReconcileState(h.db, workspaceId, { highWaterMark: '2026-07-11T10:00:00.000Z' });
    const s = await getWorkspaceSettings(h.db, workspaceId);
    expect(s.scope_jql).toBe('labels = ai-pipeline');
    expect(s.reconcile).toEqual({
      high_water_mark: '2026-07-11T10:00:00.000Z',
      active_sprint_ids: [4123, 4124],
    });
  });

  it('reads a legacy single active_sprint_id as a one-element set (read-compat)', async () => {
    await patchWorkspaceSettings(h.db, workspaceId, {
      reconcile: { active_sprint_id: 777 },
    });
    expect((await getReconcileState(h.db, workspaceId)).activeSprintIds).toEqual([777]);
  });

  it('REGRESSION: a Jira-offset timestamp is normalized to UTC ISO before the strict schema sees it', async () => {
    // Real Jira `updated` carries a numeric offset ("+0300"); the strict
    // z.string().datetime() rejected it at write time (live iteration-5 find —
    // mock-jira always emitted Z, so no suite caught it).
    await setReconcileState(h.db, workspaceId, { highWaterMark: '2026-07-12T14:03:21.123+0300' });
    expect((await getReconcileState(h.db, workspaceId)).highWaterMark).toBe(
      '2026-07-12T11:03:21.123Z',
    );

    await expect(
      setReconcileState(h.db, workspaceId, { highWaterMark: 'not-a-date' }),
    ).rejects.toThrow(/not a parseable timestamp/);
  });
});
