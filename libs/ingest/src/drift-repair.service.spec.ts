import { describe, it, expect, vi } from 'vitest';
import type { PipelineService } from '@brigadir/pipeline';
import { DriftRepairService } from './drift-repair.service';
import type { WorkspaceContext } from './poller.service';

/**
 * SXF-1174 (remediation Problem 4): one poisoned run must not starve the rest
 * of the pending set — each `onRunFinished` is isolated in its own try/catch.
 */
describe('DriftRepairService.repair — per-run isolation (SXF-1174)', () => {
  const ws: WorkspaceContext = { id: 'ws-1', projectKey: 'BRIG', boardId: 42, boardType: 'kanban' };

  function fakeDb(rows: Array<{ runId: string }>) {
    const c = {
      from: () => c,
      where: () => c,
      orderBy: () => Promise.resolve(rows),
    };
    return { select: () => c };
  }

  it('a throwing repair does not abort the loop: later pending runs are still repaired', async () => {
    const onRunFinished = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const service = new DriftRepairService(
      fakeDb([{ runId: 'run-a' }, { runId: 'run-b' }]) as never,
      { onRunFinished } as unknown as PipelineService,
    );

    await expect(service.repair(ws)).resolves.toBeUndefined();

    expect(onRunFinished).toHaveBeenCalledTimes(2);
    expect(onRunFinished).toHaveBeenNthCalledWith(1, 'run-a');
    expect(onRunFinished).toHaveBeenNthCalledWith(2, 'run-b');
  });
});
