import { describe, it, expect, vi } from 'vitest';
import { schema } from '@brigadir/database';
import type { RunsService } from '@brigadir/runs';
import type { PipelineService, SetupApplyService } from '@brigadir/pipeline';
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
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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

  it('complete: returns immediately even when onRunFinished is slow', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    let onRunFinishedResolved = false;
    const onRunFinished = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            onRunFinishedResolved = true;
            resolve();
          }, 5000);
        }),
    );

    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest: vi.fn() } as unknown as HumanTaskService,
    );

    const start = performance.now();
    const result = await service.complete('run-1', {
      schema_version: 1,
      outcome: 'success',
      summary: 'done',
      checks: [],
    });
    const elapsed = performance.now() - start;

    expect(result).toEqual({ ok: true, outcome: 'success' });
    expect(finalizeWithReport).toHaveBeenCalledTimes(1);
    expect(onRunFinished).toHaveBeenCalledWith('run-1');
    expect(elapsed).toBeLessThan(100);
    expect(onRunFinishedResolved).toBe(false);
  });

  it('complete: invalid report (needs_human without human_task) → validation failure, no finalize', async () => {
    const finalizeWithReport = vi.fn();
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      {} as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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

  it('complete: scrubs routing.task before persistence (feature 010, FR-003)', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      {} as unknown as HumanTaskService,
    );

    const secret = 'sk-ant-' + 'b'.repeat(30);
    await service.complete('run-1', {
      schema_version: 1,
      outcome: 'routed',
      summary: 'routing back to Developer',
      checks: [],
      routing: { target_agent: 'Developer', task: `fix it using ${secret}` },
    });

    const [, scrubbedReport] = finalizeWithReport.mock.calls[0];
    expect(JSON.stringify(scrubbedReport)).not.toContain(secret);
    // The bounded agent name is untouched.
    expect(scrubbedReport.routing.target_agent).toBe('Developer');
  });

  // Feature 019 (research D7): artifacts were previously unscrubbed — both
  // the legacy flat form and repos[] now pass the scrubber field-by-field.
  it('complete: scrubs artifact strings in BOTH forms before finalize', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      {} as unknown as HumanTaskService,
    );

    const secret = 'sk-ant-' + 'c'.repeat(30);
    await service.complete('run-1', {
      schema_version: 2,
      outcome: 'success',
      summary: 'done',
      checks: [],
      artifacts: {
        branch: `feat/${secret}`,
        commits: [`abc ${secret}`],
        repos: [
          { repo: 'lib', branch: `feat/${secret}`, pr_url: `https://pr?t=${secret}`, commits: [`def ${secret}`], files_changed: 1 },
        ],
      },
    });

    const [, scrubbedReport] = finalizeWithReport.mock.calls[0];
    expect(JSON.stringify(scrubbedReport)).not.toContain(secret);
    // Structure survives scrubbing — counts and repo names intact.
    expect(scrubbedReport.artifacts.repos[0].repo).toBe('lib');
    expect(scrubbedReport.artifacts.repos[0].files_changed).toBe(1);
  });

  // Feature 019 (research D6): several PRs → ONE review task listing them all.
  it('complete: multiple repos[] PRs queue one review task with a per-repo list', async () => {
    const createFromRequest = vi.fn().mockResolvedValue({ created: true, blocking: false, mayFinishWithoutComplete: false });
    const service = new CallbackService(
      fakeDb({ agentBehavior: { code_delivery: 'pull_request' } }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport: vi.fn().mockResolvedValue(true) } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    await service.complete('run-1', {
      schema_version: 2,
      outcome: 'success',
      summary: 'shipped both',
      checks: [],
      artifacts: {
        repos: [
          { repo: 'lib', pr_url: 'https://github.com/acme/lib/pull/1' },
          { repo: 'consumer', pr_url: 'https://github.com/acme/consumer/pull/2' },
        ],
      },
    });

    expect(createFromRequest).toHaveBeenCalledTimes(1);
    const [, request] = createFromRequest.mock.calls[0];
    expect(request.title).toBe('Review PRs (2)');
    expect(request.details).toContain('- lib: https://github.com/acme/lib/pull/1');
    expect(request.details).toContain('- consumer: https://github.com/acme/consumer/pull/2');
  });

  it('complete: success + pull_request delivery + pr_url queues a non-blocking review task', async () => {
    const createFromRequest = vi.fn().mockResolvedValue({ created: true, blocking: false, mayFinishWithoutComplete: false });
    const service = new CallbackService(
      fakeDb({ agentBehavior: { code_delivery: 'pull_request' } }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport: vi.fn().mockResolvedValue(true) } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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

  // --- feature 024 (US3): completion gate ---

  // A db that serves the gate's start-ref query and captures inserts. The gate
  // reads run_events (type 'log') via select().from().where() → the array of
  // start-ref rows; every other select shape resolves empty.
  function gateDb(startRefRows: Array<{ repo: string; startSha: string }>) {
    const inserted: unknown[] = [];
    const rows = startRefRows.map((r) => ({
      payload: { source: 'start-ref', repo: r.repo, startSha: r.startSha },
    }));
    const db = {
      inserted,
      insert: () => ({
        values: async (v: unknown) => {
          inserted.push(v);
        },
      }),
      select: () => ({
        from: () => ({
          // gate baseline query: from().where() resolves to the start-ref rows
          where: async () => rows,
          innerJoin: () => ({ where: () => ({ limit: async () => [{ behavior: {} }] }) }),
          limit: async () => [],
        }),
      }),
    };
    return db;
  }

  function makeGateService(db: unknown, finalizeWithReport = vi.fn().mockResolvedValue(true)) {
    return new CallbackService(
      db as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished: vi.fn().mockResolvedValue(undefined) } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest: vi.fn().mockResolvedValue({ created: true, blocking: false }) } as unknown as HumanTaskService,
    );
  }

  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const observedHeader = (m: Record<string, string>) => JSON.stringify(m);

  it('complete: rejects a completion that omits a repo whose HEAD moved; run stays active + violation event', async () => {
    const db = gateDb([{ repo: 'product', startSha: A }]);
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = makeGateService(db, finalizeWithReport);

    const result = await service.complete(
      'run-1',
      { schema_version: 2, outcome: 'success', summary: 's', checks: [] },
      observedHeader({ product: B }),
    );

    expect(result).toMatchObject({ kind: 'validation' });
    expect(finalizeWithReport).not.toHaveBeenCalled();
    const violation = (db.inserted as Array<{ payload?: { source?: string } }>).find(
      (e) => e.payload?.source === 'handoff-violation',
    );
    expect(violation).toBeDefined();
    expect((violation as { payload: { violations: unknown[] } }).payload.violations).toHaveLength(1);
  });

  it('complete: accepts when the moved repo IS reported (v2 entry present)', async () => {
    const db = gateDb([{ repo: 'product', startSha: A }]);
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = makeGateService(db, finalizeWithReport);

    const result = await service.complete(
      'run-1',
      {
        schema_version: 2,
        outcome: 'success',
        summary: 's',
        checks: [],
        artifacts: { repos: [{ repo: 'product', branch: 'run/T' }] },
      },
      observedHeader({ product: B }),
    );

    expect(result).toEqual({ ok: true, outcome: 'success' });
    expect(finalizeWithReport).toHaveBeenCalledTimes(1);
  });

  it('complete: accepts when no observed-heads header is present (evidence absent)', async () => {
    const db = gateDb([{ repo: 'product', startSha: A }]);
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = makeGateService(db, finalizeWithReport);

    const result = await service.complete('run-1', {
      schema_version: 2,
      outcome: 'success',
      summary: 's',
      checks: [],
    });

    expect(result).toEqual({ ok: true, outcome: 'success' });
    expect(finalizeWithReport).toHaveBeenCalledTimes(1);
  });

  it('complete: accepts when HEAD did not move', async () => {
    const db = gateDb([{ repo: 'product', startSha: A }]);
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = makeGateService(db, finalizeWithReport);

    const result = await service.complete(
      'run-1',
      { schema_version: 2, outcome: 'success', summary: 's', checks: [] },
      observedHeader({ product: A }),
    );

    expect(result).toEqual({ ok: true, outcome: 'success' });
    expect(finalizeWithReport).toHaveBeenCalledTimes(1);
  });

  // --- feature 033: ticket-level verification receipt ---

  // A db that serves the gate baseline query, the runs⨝agents lookup (both the
  // receipt writer's and maybeQueueReviewTask's — same chain shape, one row
  // carrying all selected fields), captures tickets updates and event inserts.
  function receiptDb(opts: {
    startRefRows?: Array<{ repo: string; startSha: string }>;
    runRow?: { ticketId: string | null; agentRole: string | null; agentName: string | null };
    failTicketUpdate?: boolean;
  }) {
    const inserted: Array<{ payload?: { source?: string } }> = [];
    const ticketUpdates: unknown[] = [];
    const startRefs = (opts.startRefRows ?? []).map((r) => ({
      payload: { source: 'start-ref', repo: r.repo, startSha: r.startSha },
    }));
    const joinRow = opts.runRow ? [{ ...opts.runRow, behavior: {} }] : [];
    return {
      inserted,
      ticketUpdates,
      insert: () => ({
        values: async (v: { payload?: { source?: string } }) => {
          inserted.push(v);
        },
      }),
      update: () => ({
        set: (vals: unknown) => ({
          where: async () => {
            if (opts.failTicketUpdate) throw new Error('tickets update exploded');
            ticketUpdates.push(vals);
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: async () => startRefs,
          innerJoin: () => ({ where: () => ({ limit: async () => joinRow }) }),
          limit: async () => [],
        }),
      }),
    };
  }

  function makeReceiptService(db: unknown) {
    return new CallbackService(
      db as never,
      fakeModuleRef() as never,
      { finalizeWithReport: vi.fn().mockResolvedValue(true) } as unknown as RunsService,
      { onRunFinished: vi.fn().mockResolvedValue(undefined) } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest: vi.fn().mockResolvedValue({ created: true, blocking: false }) } as unknown as HumanTaskService,
    );
  }

  const receiptRunRow = { ticketId: 'ticket-1', agentRole: 'Developer', agentName: 'Nemo' };

  it('complete: writes a ticket verification receipt (pass checks only) and a receipt event', async () => {
    const db = receiptDb({ startRefRows: [{ repo: 'product', startSha: A }], runRow: receiptRunRow });
    const service = makeReceiptService(db);

    const result = await service.complete(
      'run-1',
      {
        schema_version: 1,
        outcome: 'success',
        summary: 'done',
        checks: [
          { name: 'lint', status: 'pass' },
          { name: 'e2e', status: 'fail' },
        ],
      },
      observedHeader({ product: A }),
    );

    expect(result).toEqual({ ok: true, outcome: 'success' });
    expect(db.ticketUpdates).toHaveLength(1);
    const update = db.ticketUpdates[0] as { verification: { gates: string[]; repos: Record<string, string>; runId: string } };
    expect(update.verification.gates).toEqual(['lint']);
    expect(update.verification.repos).toEqual({ product: A });
    expect(update.verification.runId).toBe('run-1');
    const event = db.inserted.find((e) => e.payload?.source === 'verification-receipt');
    expect(event).toBeDefined();
    expect((event as { payload: { message: string } }).payload.message).toContain('lint');
    expect((event as { payload: { message: string } }).payload.message).toContain(`product@${A.slice(0, 7)}`);
  });

  it('complete: no receipt without an observed-heads header', async () => {
    const db = receiptDb({ runRow: receiptRunRow });
    const service = makeReceiptService(db);

    await service.complete('run-1', {
      schema_version: 1,
      outcome: 'success',
      summary: 'done',
      checks: [{ name: 'lint', status: 'pass' }],
    });

    expect(db.ticketUpdates).toHaveLength(0);
  });

  it('complete: no receipt for a ticketless run', async () => {
    const db = receiptDb({
      startRefRows: [{ repo: 'product', startSha: A }],
      runRow: { ticketId: null, agentRole: null, agentName: null },
    });
    const service = makeReceiptService(db);

    await service.complete(
      'run-1',
      { schema_version: 1, outcome: 'success', summary: 'done', checks: [{ name: 'lint', status: 'pass' }] },
      observedHeader({ product: A }),
    );

    expect(db.ticketUpdates).toHaveLength(0);
  });

  it('complete: no receipt when the report has zero pass checks', async () => {
    const db = receiptDb({ startRefRows: [{ repo: 'product', startSha: A }], runRow: receiptRunRow });
    const service = makeReceiptService(db);

    await service.complete(
      'run-1',
      { schema_version: 1, outcome: 'failure', summary: 'broke', checks: [{ name: 'lint', status: 'fail' }] },
      observedHeader({ product: A }),
    );

    expect(db.ticketUpdates).toHaveLength(0);
    expect(db.inserted.find((e) => e.payload?.source === 'verification-receipt')).toBeUndefined();
  });

  it('complete: a failure outcome with honest pass checks still records a receipt', async () => {
    const db = receiptDb({ startRefRows: [{ repo: 'product', startSha: A }], runRow: receiptRunRow });
    const service = makeReceiptService(db);

    await service.complete(
      'run-1',
      {
        schema_version: 1,
        outcome: 'failure',
        summary: 'one e2e is flaky',
        checks: [
          { name: 'lint', status: 'pass' },
          { name: 'typecheck', status: 'pass' },
          { name: 'e2e', status: 'fail' },
        ],
      },
      observedHeader({ product: A }),
    );

    expect(db.ticketUpdates).toHaveLength(1);
    const update = db.ticketUpdates[0] as { verification: { gates: string[]; outcome: string } };
    expect(update.verification.gates).toEqual(['lint', 'typecheck']);
    expect(update.verification.outcome).toBe('failure');
  });

  it('complete: a receipt-write failure never breaks the completion (fail-open)', async () => {
    const db = receiptDb({
      startRefRows: [{ repo: 'product', startSha: A }],
      runRow: receiptRunRow,
      failTicketUpdate: true,
    });
    const service = makeReceiptService(db);

    const result = await service.complete(
      'run-1',
      { schema_version: 1, outcome: 'success', summary: 'done', checks: [{ name: 'lint', status: 'pass' }] },
      observedHeader({ product: A }),
    );

    expect(result).toEqual({ ok: true, outcome: 'success' });
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
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
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
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    const secret = 'ghp_' + 'a'.repeat(40);
    const result = await service.human('run-1', {
      kind: 'question',
      title: 'Which flow?',
      details: `use ${secret}`,
      blocking: true,
    });

    expect(result).toEqual({ ok: true, created: true, blocking: true, mayFinishWithoutComplete: true });
    const [, passedInput] = createFromRequest.mock.calls[0];
    expect(passedInput.details).not.toContain(secret);
  });

  it('human: a dedup no-op surfaces created:false to the agent (SXF-1174 Problem 7)', async () => {
    const createFromRequest = vi
      .fn()
      .mockResolvedValue({ created: false, blocking: true, mayFinishWithoutComplete: true });
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      {} as unknown as RunsService,
      {} as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    const result = await service.human('run-1', {
      kind: 'blocker',
      title: 'Same question again',
      details: 'dup',
      blocking: true,
    });

    expect(result).toEqual({ ok: true, created: false, blocking: true, mayFinishWithoutComplete: true });
  });

  // --- feature 013: answer options through both intake surfaces ---

  it('human: scrubs option label/value/description before delegating (Constitution V)', async () => {
    const createFromRequest = vi.fn().mockResolvedValue({ created: true, blocking: true, mayFinishWithoutComplete: true });
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      {} as unknown as RunsService,
      {} as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    const secret = 'ghp_' + 'c'.repeat(40);
    const result = await service.human('run-1', {
      kind: 'question',
      title: 'Which flow?',
      details: 'Pick one.',
      blocking: true,
      options: [
        { label: `token ${secret}`, value: `value ${secret}`, description: `hint ${secret}` },
        { label: 'Keep as is' },
      ],
    });

    expect(result).toEqual({ ok: true, created: true, blocking: true, mayFinishWithoutComplete: true });
    const [, passedInput] = createFromRequest.mock.calls[0];
    expect(JSON.stringify(passedInput.options)).not.toContain(secret);
    expect(passedInput.options).toHaveLength(2);
    expect(passedInput.options[1]).toEqual({ label: 'Keep as is' });
  });

  it('human: a 6-option payload is a validation failure, nothing delegated', async () => {
    const createFromRequest = vi.fn();
    const service = new CallbackService(
      fakeDb() as never,
      fakeModuleRef() as never,
      {} as unknown as RunsService,
      {} as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      { createFromRequest } as unknown as HumanTaskService,
    );

    const result = await service.human('run-1', {
      kind: 'question',
      title: 't',
      details: 'd',
      blocking: true,
      options: Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` })),
    });

    expect(result).toMatchObject({ kind: 'validation' });
    expect(createFromRequest).not.toHaveBeenCalled();
  });

  it('complete: scrubs human_task.options before finalize (needs_human path)', async () => {
    const finalizeWithReport = vi.fn().mockResolvedValue(true);
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { acceptTeamReport: vi.fn() } as unknown as SetupApplyService,
      {} as unknown as HumanTaskService,
    );

    const secret = 'sk-ant-' + 'd'.repeat(30);
    await service.complete('run-1', {
      schema_version: 1,
      outcome: 'needs_human',
      summary: 'stuck',
      checks: [],
      human_task: {
        kind: 'question',
        title: 'Which one?',
        options: [{ label: `use ${secret}`, value: `${secret}-value` }],
      },
    });

    const [, scrubbedReport] = finalizeWithReport.mock.calls[0];
    expect(JSON.stringify(scrubbedReport.human_task.options)).not.toContain(secret);
  });

  // --- feature 011: the `team` accept path ---

  it('complete: team outcome routes through SetupApplyService; invalid → 422-shaped validation, no finalize', async () => {
    const finalizeWithReport = vi.fn();
    const acceptTeamReport = vi
      .fn()
      .mockResolvedValue({ kind: 'invalid', issues: [{ path: ['team'], code: 'status_absent', message: 'x' }] });
    const onRunFinished = vi.fn();
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport } as unknown as RunsService,
      { onRunFinished } as unknown as PipelineService,
      { acceptTeamReport } as unknown as SetupApplyService,
      {} as unknown as HumanTaskService,
    );

    const result = await service.complete('run-1', teamReportBody());
    expect(result).toMatchObject({ kind: 'validation' });
    expect(finalizeWithReport).not.toHaveBeenCalled();
    expect(onRunFinished).not.toHaveBeenCalled();
  });

  it('complete: team outcome applied → ok/team + onRunFinished (marker branch)', async () => {
    const acceptTeamReport = vi.fn().mockResolvedValue({ kind: 'applied', agentsCreated: 2 });
    const onRunFinished = vi.fn().mockResolvedValue(undefined);
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport: vi.fn() } as unknown as RunsService,
      { onRunFinished } as unknown as PipelineService,
      { acceptTeamReport } as unknown as SetupApplyService,
      {} as unknown as HumanTaskService,
    );

    const result = await service.complete('run-1', teamReportBody());
    expect(result).toEqual({ ok: true, outcome: 'team' });
    expect(onRunFinished).toHaveBeenCalledWith('run-1');
  });

  it('complete: scrubs team description/instruction before the accept path (FR-018)', async () => {
    const acceptTeamReport = vi.fn().mockResolvedValue({ kind: 'applied', agentsCreated: 1 });
    const service = new CallbackService(
      fakeDb({ agentBehavior: {} }) as never,
      fakeModuleRef() as never,
      { finalizeWithReport: vi.fn() } as unknown as RunsService,
      { onRunFinished: vi.fn() } as unknown as PipelineService,
      { acceptTeamReport } as unknown as SetupApplyService,
      {} as unknown as HumanTaskService,
    );

    const secret = 'sk-ant-' + 'c'.repeat(30);
    await service.complete('run-1', teamReportBody(`uses ${secret} internally`));
    const [, scrubbed] = acceptTeamReport.mock.calls[0];
    expect(JSON.stringify(scrubbed.team)).not.toContain(secret);
    // Identifier fields untouched.
    expect(scrubbed.team.agents[0].name).toBe('Developer');
  });
});

function teamReportBody(instruction = 'Implement tickets.') {
  return {
    schema_version: 1,
    outcome: 'team',
    summary: 'Proposed the team.',
    checks: [],
    team: {
      agents: [
        {
          name: 'Developer',
          description: 'Implements tickets.',
          instruction,
          trigger_status: 'To Do',
          status_success: 'In Review',
          status_failure: 'Blocked',
          executor: 'mock-default',
        },
      ],
    },
  };
}
