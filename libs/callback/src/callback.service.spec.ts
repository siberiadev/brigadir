import { describe, it, expect, vi } from 'vitest';
import { schema } from '@brigadir/database';
import type { RunsService } from '@brigadir/runs';
import type { PipelineService } from '@brigadir/pipeline';
import type { HumanTaskService } from '@brigadir/human-tasks';
import { CallbackService } from './callback.service';

function fakeDb(overrides: { agentBehavior?: unknown; executorType?: string } = {}): unknown {
  return {
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => (overrides.agentBehavior !== undefined ? [{ behavior: overrides.agentBehavior }] : []),
          }),
        }),
        where: () => ({
          limit: async () => (overrides.executorType ? [{ executorType: overrides.executorType }] : []),
        }),
      }),
    }),
  };
}

function fakeModuleRef(): unknown {
  return { get: vi.fn(() => ({ getJob: vi.fn().mockResolvedValue(undefined) })) };
}

describe('CallbackService (T100)', () => {
  it('complete: valid success report finalizes and calls onRunFinished', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const onRunFinished = vi.fn().mockResolvedValue(undefined);
    const createFromRequest = vi.fn();

    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished } as unknown as PipelineService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    const result = await service.complete('run-1', {
      schema_version: 1,
      outcome: 'success',
      summary: 'done',
      checks: [],
    });

    expect(result).toEqual({ ok: true, outcome: 'success' });
    expect(finalizeWithReport).toHaveBeenCalledTimes(1);
    expect(onRunFinished).toHaveBeenCalledWith('run-1');
  });

  it('complete: invalid report (needs_human without human_task) → validation failure, no finalize', async () => {
    const finalizeWithReport = vi.fn();
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      {} as unknown as PipelineService,
      {} as unknown as HumanTaskService,
    );

    const result = await service.complete('run-1', {
      schema_version: 1,
      outcome: 'needs_human',
      summary: 'stuck',
      checks: [],
    });

    expect(result).toMatchObject({ kind: 'validation' });
    expect(finalizeWithReport).not.toHaveBeenCalled();
  });

  it('complete: finalizeWithReport returning false (already finalized) → conflict', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(false);
    const onRunFinished = vi.fn();
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished } as unknown as PipelineService,
      {} as unknown as HumanTaskService,
    );

    const result = await service.complete('run-1', {
      schema_version: 1,
      outcome: 'success',
      summary: 'done',
      checks: [],
    });

    expect(result).toEqual({ kind: 'conflict' });
    expect(onRunFinished).not.toHaveBeenCalled();
  });

  it('complete: scrubs summary/check reasons before calling finalizeWithReport', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      {} as unknown as HumanTaskService,
    );

    const secret = 'sk-ant-' + 'a'.repeat(30);
    await service.complete('run-1', {
      schema_version: 1,
      outcome: 'failure',
      summary: `leaked ${secret}`,
      checks: [{ name: 'x', status: 'fail', reason: `also leaked ${secret}` }],
    });

    const [, scrubbedReport] = finalizeWithReport.mock.calls[0];
    expect(JSON.stringify(scrubbedReport)).not.toContain(secret);
  });

  it('complete: success + pull_request delivery + pr_url queues a non-blocking review task', async () => {
    const createFromRequest = vi.fn().mockResolvedValue({ created: true, blocking: false, mayFinishWithoutComplete: false });
    const service = new CallbackService(
      fakeDb({ agentBehavior: { code_delivery: 'pull_request' } }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport: vi.fn().mockResolvedValue(true) } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    await service.complete('run-1', {
      schema_version: 1,
      outcome: 'success',
      summary: 'shipped',
      checks: [],
      artifacts: { pr_url: 'https://github.com/acme/repo/pull/1' },
    });

    expect(createFromRequest).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ kind: 'review', blocking: false }),
    );
  });

  it('progress: valid input inserts a run_events row and returns ok', async () => {
    const inserted: unknown[] = [];
    const db = {
      insert: (table: unknown) => ({
        values: async (vals: unknown) => {
          if (table === schema.runEvents) inserted.push(vals);
        },
      }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    };
    const service = new CallbackService(
      db as never,
      fakeModuleRef() as never,
      {} as unknown as RunsService,
      {} as unknown as PipelineService,
      {} as unknown as HumanTaskService,
    );

    const result = await service.progress('run-1', { stage: 'implementing', message: 'wiring things' });
    expect(result).toEqual({ ok: true });
    expect(inserted).toHaveLength(1);
  });

  it('progress: invalid input (missing stage) is a validation failure, no insert', async () => {
    const values = vi.fn();
    const db = { insert: () => ({ values }) };
    const service = new CallbackService(
      db as never,
      fakeModuleRef() as never,
      {} as unknown as RunsService,
      {} as unknown as PipelineService,
      {} as unknown as HumanTaskService,
    );

    const result = await service.progress('run-1', { message: 'no stage' });
    expect(result).toMatchObject({ kind: 'validation' });
    expect(values).not.toHaveBeenCalled();
  });

  it('human: delegates to HumanTaskService with scrubbed title/details', async () => {
    const createFromRequest = vi.fn().mockResolvedValue({ created: true, blocking: true, mayFinishWithoutComplete: true });
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      {} as unknown as RunsService,
      {} as unknown as PipelineService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    const secret = 'ghp_' + 'a'.repeat(40);
    const result = await service.human('run-1', {
      kind: 'question',
      title: 'Which flow?',
      details: `use ${secret}`,
      blocking: true,
    });

    expect(result).toEqual({ ok: true, blocking: true, mayFinishWithoutComplete: true });
    const [, passedInput] = createFromRequest.mock.calls[0];
    expect(passedInput.details).not.toContain(secret);
  });
});
