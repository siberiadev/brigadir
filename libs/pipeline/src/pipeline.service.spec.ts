import { describe, it, expect, vi } from 'vitest';
import type { RunTriggerService } from '@brigadir/runs';
import type { HumanTaskService } from '@brigadir/human-tasks';
import { NoTransitionPath, type JiraClientFactory } from '@brigadir/jira';
import { PipelineService } from './pipeline.service';

/**
 * T023 (US2, AC US2-5 / FR-002): a `routed` report from a NON-orchestrator agent
 * is invalid — the pipeline treats the run as a failure (transitions to the
 * agent's failure status) and notes the invalid outcome in the Jira comment,
 * never enqueuing a rework run.
 */

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Promise<unknown[]>;
}

function chain(rows: unknown[]): Chain {
  const c: Chain = { from: () => c, where: () => c, limit: () => Promise.resolve(rows) };
  return c;
}

describe('PipelineService.onRunFinished — non-orchestrator routed (T023)', () => {
  it('treats a worker "routed" report as a failure and notes it in the comment', async () => {
    const run = {
      status: 'succeeded', // routed maps to succeeded at finalize time
      report: {
        schema_version: 1,
        outcome: 'routed',
        summary: 'I think this should go to the Reviewer.',
        checks: [],
        routing: { target_agent: 'Reviewer', task: 'please review' },
      },
      error: null,
      agentId: 'agent-dev',
      ticketId: 'ticket-1',
      workspaceId: 'ws-1',
      triggerEvent: { source: 'poll' },
    };
    const agent = {
      name: 'Developer',
      statusSuccess: 'Done',
      statusFailure: 'Blocked',
      isOrchestrator: false,
    };
    const ticket = { jiraKey: 'BRIG-1' };

    const inserted: Array<{ type?: string; payload?: unknown }> = [];
    const db = {
      select: (cols: Record<string, unknown>) => {
        const keys = Object.keys(cols ?? {});
        if (keys.includes('status') && keys.includes('report')) return chain([run]);
        if (keys.includes('isOrchestrator')) return chain([agent]);
        if (keys.includes('jiraKey')) return chain([ticket]);
        return chain([]); // marker guard: no jira_action yet
      },
      insert: () => ({
        values: async (v: { type?: string; payload?: unknown }) => {
          inserted.push(v);
        },
      }),
    };

    const transitionTo = vi.fn().mockResolvedValue(undefined);
    const addComment = vi.fn().mockResolvedValue(undefined);
    const jiraFactory = {
      forWorkspace: vi.fn().mockResolvedValue({ transitionTo, addComment }),
    } as unknown as JiraClientFactory;

    const runTrigger = { trigger: vi.fn() } as unknown as RunTriggerService;
    const humanTasks = { createNonBlocking: vi.fn() } as unknown as HumanTaskService;

    const service = new PipelineService(
      db as never,
      jiraFactory,
      runTrigger,
      humanTasks,
    );

    await service.onRunFinished('run-1');

    // Transitioned to the FAILURE status, not success.
    expect(transitionTo).toHaveBeenCalledWith('BRIG-1', 'Blocked');
    // The comment notes the invalid outcome.
    const [, commentDoc] = addComment.mock.calls[0];
    expect(JSON.stringify(commentDoc)).toMatch(/invalid "routed" outcome|only the orchestrator/i);
    // No rework enqueued, no human task.
    expect(runTrigger.trigger).not.toHaveBeenCalled();
    expect(humanTasks.createNonBlocking).not.toHaveBeenCalled();
    // Marker written (no triage_decision — status was 'succeeded').
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker).toBeDefined();
  });
});

/**
 * Answer-triage delta (FR-026): a routed decision from an `answer-triage` run
 * (human-initiated) is exempt from the exhausted-budget override — the human
 * answer grants one extra rework cycle. An automatic `triage` decision keeps
 * the hard cap.
 */
describe('PipelineService.processOrchestratorDecision — budget bypass (answer-triage)', () => {
  const FAILING_RUN_ID = '11111111-1111-4111-8111-111111111111';
  const HUMAN_TASK_ID = '33333333-3333-4333-8333-333333333333';

  // Like `chain`, but also awaitable without `.limit()` — the budget count
  // query (`getReworkBudget`) awaits the builder directly. `innerJoin` for the
  // active-run-on-ticket lookup (SXF-1174 Problem 6).
  function awaitableChain(rows: unknown[]) {
    const c = {
      from: () => c,
      innerJoin: () => c,
      where: () => c,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return c;
  }

  function setup(triggerSource: 'answer-triage' | 'triage', opts: { cycleCount?: number } = {}) {
    const cycleCount = opts.cycleCount ?? 2;
    const run = {
      status: 'succeeded',
      report: {
        schema_version: 1,
        outcome: 'routed',
        summary: 'Route to Developer with the clarified spec.',
        checks: [],
        routing: { target_agent: 'Developer', task: 'Apply the decision, then fix the code.' },
      },
      error: null,
      agentId: 'agent-brigadir',
      ticketId: 'ticket-1',
      workspaceId: 'ws-1',
      triggerEvent: {
        source: triggerSource,
        failing_run_id: FAILING_RUN_ID,
        ...(triggerSource === 'answer-triage' ? { human_task_id: HUMAN_TASK_ID } : {}),
      },
    };
    const agent = {
      name: 'brigadir',
      statusSuccess: '—',
      statusFailure: '—',
      isOrchestrator: true,
    };
    const target = { id: 'agent-dev', statusRunning: 'In Progress', behavior: {} };

    const inserted: Array<{ type?: string; payload?: unknown }> = [];
    const db = {
      select: (cols: Record<string, unknown>) => {
        const keys = Object.keys(cols ?? {});
        if (keys.includes('status') && keys.includes('report')) return awaitableChain([run]);
        if (keys.includes('isOrchestrator')) return awaitableChain([agent]);
        if (keys.includes('jiraKey')) return awaitableChain([{ jiraKey: 'BRIG-1' }]);
        if (keys.includes('statusRunning')) return awaitableChain([target]); // resolveRoutingTarget
        if (keys.includes('count')) return awaitableChain([{ count: cycleCount }]); // budget count (max 2)
        if (keys.includes('settings')) return awaitableChain([{ settings: { rework_max: 2 } }]);
        return awaitableChain([]); // marker guard
      },
      insert: () => ({
        values: async (v: { type?: string; payload?: unknown }) => {
          inserted.push(v);
        },
      }),
    };

    const transitionTo = vi.fn().mockResolvedValue(undefined);
    const addComment = vi.fn().mockResolvedValue(undefined);
    const jiraFactory = {
      forWorkspace: vi.fn().mockResolvedValue({ transitionTo, addComment }),
    } as unknown as JiraClientFactory;
    const runTrigger = { trigger: vi.fn().mockResolvedValue({ deduplicated: false, runId: 'run-rw' }) };
    const humanTasks = { createNonBlocking: vi.fn() };

    const service = new PipelineService(
      db as never,
      jiraFactory,
      runTrigger as unknown as RunTriggerService,
      humanTasks as unknown as HumanTaskService,
    );
    return { service, runTrigger, humanTasks, transitionTo, inserted };
  }

  it('answer-triage decision routes past an exhausted budget and forwards human_task_id', async () => {
    const { service, runTrigger, humanTasks, transitionTo, inserted } = setup('answer-triage');

    await service.onRunFinished('run-triage');

    expect(humanTasks.createNonBlocking).not.toHaveBeenCalled();
    expect(runTrigger.trigger).toHaveBeenCalledTimes(1);
    const { triggerEvent } = (runTrigger.trigger as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(triggerEvent.source).toBe('rework');
    expect(triggerEvent.failing_run_id).toBe(FAILING_RUN_ID);
    expect(triggerEvent.human_task_id).toBe(HUMAN_TASK_ID); // traceability
    expect(transitionTo).toHaveBeenCalledWith('BRIG-1', 'In Progress');
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker?.payload).toMatchObject({ orchestrator_decision: 'routed' });
  });

  it('automatic triage decision keeps the hard cap (override to a human task)', async () => {
    const { service, runTrigger, humanTasks, inserted } = setup('triage');

    await service.onRunFinished('run-triage');

    expect(runTrigger.trigger).not.toHaveBeenCalled();
    expect(humanTasks.createNonBlocking).toHaveBeenCalledTimes(1);
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker?.payload).toMatchObject({ orchestrator_decision: 'override_budget' });
  });

  it('answer-triage past max + 1 is overridden — the human grant is a hard cap, not a blanket bypass (SXF-1174)', async () => {
    // cycleCount 3 with max 2: the one human-granted extra cycle is consumed.
    const { service, runTrigger, humanTasks, inserted } = setup('answer-triage', { cycleCount: 3 });

    await service.onRunFinished('run-triage');

    expect(runTrigger.trigger).not.toHaveBeenCalled();
    expect(humanTasks.createNonBlocking).toHaveBeenCalledTimes(1);
    const [, task] = (humanTasks.createNonBlocking as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(task.details)).toMatch(/human-granted extra cycle is already used/);
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker?.payload).toMatchObject({ orchestrator_decision: 'override_budget' });
  });
});

/**
 * Feature 032 (T010): the status-change path reads the SAME workspace setting
 * as the release pass and threads it into the gate (FR-003), writes the full
 * observed link set into `blocked_by`, and annotates an early release.
 */
describe('PipelineService.onStatusChanged — configurable release status (feature 032)', () => {
  const dependentIssue = (blockerStatus: string, category: 'new' | 'indeterminate' | 'done') => ({
    key: 'DEP-1',
    id: '1',
    fields: {
      summary: 'dependent',
      status: { name: 'Ready for Dev', statusCategory: { key: 'new' as const } },
      updated: '2026-07-26T00:00:00.000Z',
      issuelinks: [
        {
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: {
            key: 'BLK-1',
            fields: { status: { name: blockerStatus, statusCategory: { key: category } } },
          },
        },
        {
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: {
            key: 'BLK-2',
            fields: { status: { name: 'Done', statusCategory: { key: 'done' as const } } },
          },
        },
      ],
    },
  });

  function harness(settings: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const events: { runId?: string; payload?: Record<string, unknown> }[] = [];
    const agentsRow = [{ id: 'agent-1', name: 'Developer', behavior: {} }];

    const thenable = (rows: unknown[]) => {
      const c = {
        from: () => c,
        where: () => c,
        limit: () => Promise.resolve(rows),
        then: (resolve: (r: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      };
      return c;
    };

    const db = {
      select: (cols?: Record<string, unknown>) => {
        const keys = Object.keys(cols ?? {});
        if (keys.length === 1 && keys[0] === 'settings') return thenable([{ settings }]);
        if (keys.includes('workspaceId') && keys.includes('jiraKey')) {
          return thenable([{ workspaceId: 'ws-1', jiraKey: 'DEP-1' }]);
        }
        return thenable(agentsRow);
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
      insert: () => ({
        values: (row: { runId?: string; payload?: Record<string, unknown> }) => {
          events.push(row);
          return Promise.resolve();
        },
      }),
    };

    const trigger = vi.fn().mockResolvedValue({ deduplicated: false, runId: 'run-new' });
    const service = new PipelineService(
      db as never,
      {} as unknown as JiraClientFactory,
      { trigger } as unknown as RunTriggerService,
      {} as unknown as HumanTaskService,
      {} as never,
    );
    return { service, trigger, updates, events };
  }

  it('triggers when the blocker carries the configured status (not done)', async () => {
    const h = harness({ dependency_release_status: 'In Review' });
    await h.service.onStatusChanged({
      ticketId: 't-1',
      issue: dependentIssue('In Review', 'indeterminate') as never,
      fromStatus: 'Backlog',
      toStatus: 'Ready for Dev',
      source: 'poller',
    });
    expect(h.trigger).toHaveBeenCalledTimes(1);
    // blocked_by is the FULL observed set, including the already-done blocker.
    expect(h.updates.at(-1)).toMatchObject({ blockedBy: ['BLK-1', 'BLK-2'], blockedState: null });
    expect(h.events.at(-1)?.payload).toMatchObject({
      source: 'dependency-release',
      early: true,
      matched_status: 'In Review',
    });
  });

  it('stays waiting for the same issue when no status is configured', async () => {
    const h = harness({});
    await h.service.onStatusChanged({
      ticketId: 't-1',
      issue: dependentIssue('In Review', 'indeterminate') as never,
      fromStatus: 'Backlog',
      toStatus: 'Ready for Dev',
      source: 'poller',
    });
    expect(h.trigger).not.toHaveBeenCalled();
    // Waiting persists the full observed set too; only the OPEN one is logged.
    expect(h.updates.at(-1)).toMatchObject({
      blockedBy: ['BLK-1', 'BLK-2'],
      blockedState: 'waiting',
    });
  });

  it('does not annotate a plain done-category release', async () => {
    const h = harness({ dependency_release_status: 'In Review' });
    await h.service.onStatusChanged({
      ticketId: 't-1',
      issue: dependentIssue('Done', 'done') as never,
      fromStatus: 'Backlog',
      toStatus: 'Ready for Dev',
      source: 'poller',
    });
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
  });
});

/**
 * SXF-1174 (remediation Problems 1+2): the orchestrator completion path is
 * replay-idempotent and diagnosable. A rework run already minted for this
 * decision (any status) short-circuits the replay before target/budget checks;
 * Jira writes precede the enqueue; every failure persists a staged `error`
 * run_event.
 */
describe('PipelineService.processOrchestratorDecision — replay idempotency + diagnostics (SXF-1174)', () => {
  function awaitableChain(rows: unknown[]) {
    const c = {
      from: () => c,
      innerJoin: () => c,
      where: () => c,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return c;
  }

  function setup(opts: {
    existingRework?: { id: string; status: string };
    activeConflict?: { id: string; status: string; agentName: string };
    transitionError?: Error;
    commentError?: Error;
    triggerDeduplicated?: boolean;
  } = {}) {
    const run = {
      status: 'succeeded',
      report: {
        schema_version: 1,
        outcome: 'routed',
        summary: 'Route to Developer.',
        checks: [],
        routing: { target_agent: 'Developer', task: 'Fix the thing.' },
      },
      error: null,
      agentId: 'agent-brigadir',
      ticketId: 'ticket-1',
      workspaceId: 'ws-1',
      triggerEvent: { source: 'triage' },
    };
    const agent = { name: 'brigadir', statusSuccess: '—', statusFailure: '—', isOrchestrator: true };
    const target = { id: 'agent-dev', statusRunning: 'In Progress', behavior: {} };

    const inserted: Array<{ type?: string; payload?: unknown }> = [];
    const db = {
      select: (cols: Record<string, unknown>) => {
        const keys = Object.keys(cols ?? {});
        if (keys.includes('status') && keys.includes('report')) return awaitableChain([run]);
        if (keys.includes('isOrchestrator')) return awaitableChain([agent]);
        if (keys.includes('jiraKey')) return awaitableChain([{ jiraKey: 'BRIG-1' }]);
        if (keys.includes('statusRunning')) return awaitableChain([target]); // resolveRoutingTarget
        if (keys.includes('count')) return awaitableChain([{ count: 0 }]); // budget available
        if (keys.includes('settings')) return awaitableChain([{ settings: {} }]);
        if (keys.includes('agentName'))
          return awaitableChain(opts.activeConflict ? [opts.activeConflict] : []); // active-run-on-ticket guard
        if (keys.includes('status') && keys.includes('id'))
          return awaitableChain(opts.existingRework ? [opts.existingRework] : []); // deciding_run_id dedup
        return awaitableChain([]); // marker guard
      },
      insert: () => ({
        values: async (v: { type?: string; payload?: unknown }) => {
          inserted.push(v);
        },
      }),
    };

    const transitionTo = opts.transitionError
      ? vi.fn().mockRejectedValue(opts.transitionError)
      : vi.fn().mockResolvedValue(undefined);
    const addComment = opts.commentError
      ? vi.fn().mockRejectedValue(opts.commentError)
      : vi.fn().mockResolvedValue(undefined);
    const jiraFactory = {
      forWorkspace: vi.fn().mockResolvedValue({ transitionTo, addComment }),
    } as unknown as JiraClientFactory;
    const runTrigger = {
      trigger: vi.fn().mockResolvedValue(
        opts.triggerDeduplicated
          ? { deduplicated: true, existingRunId: 'r-x' }
          : { deduplicated: false, runId: 'run-rw' },
      ),
    };
    const humanTasks = { createNonBlocking: vi.fn() };

    const service = new PipelineService(
      db as never,
      jiraFactory,
      runTrigger as unknown as RunTriggerService,
      humanTasks as unknown as HumanTaskService,
    );
    return { service, runTrigger, humanTasks, transitionTo, addComment, inserted };
  }

  it('replay with an existing rework run (terminal) short-circuits: no Jira, no trigger, marker routed', async () => {
    const { service, runTrigger, humanTasks, transitionTo, addComment, inserted } = setup({
      existingRework: { id: 'run-old', status: 'cancelled' },
    });

    await service.onRunFinished('run-triage');

    expect(runTrigger.trigger).not.toHaveBeenCalled();
    expect(transitionTo).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(humanTasks.createNonBlocking).not.toHaveBeenCalled();
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker?.payload).toMatchObject({ orchestrator_decision: 'routed' });
  });

  it('NoTransitionPath: resolves, nothing enqueued, error event persisted, no marker', async () => {
    const { service, runTrigger, inserted } = setup({
      transitionError: new NoTransitionPath('BRIG-1', 'Blocked', 'In Progress'),
    });

    await expect(service.onRunFinished('run-triage')).resolves.toBeUndefined();

    expect(runTrigger.trigger).not.toHaveBeenCalled(); // Jira precedes the enqueue
    const errors = inserted.filter((i) => i.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ stage: 'jira_transition' });
    expect(inserted.find((i) => i.type === 'jira_action')).toBeUndefined();
  });

  it('generic comment failure: rethrows with exactly one staged error event, no marker, no trigger', async () => {
    const { service, runTrigger, inserted } = setup({ commentError: new Error('boom') });

    await expect(service.onRunFinished('run-triage')).rejects.toThrow('boom');

    expect(runTrigger.trigger).not.toHaveBeenCalled();
    const errors = inserted.filter((i) => i.type === 'error');
    expect(errors).toHaveLength(1); // no double-record from the outer catch
    expect(errors[0].payload).toMatchObject({ stage: 'jira_comment', error: 'boom' });
    expect(inserted.find((i) => i.type === 'jira_action')).toBeUndefined();
  });

  it('active run on the ticket → override_active_run before any Jira write (SXF-1174 Problem 6)', async () => {
    const { service, runTrigger, humanTasks, transitionTo, addComment, inserted } = setup({
      activeConflict: { id: 'run-busy', status: 'running', agentName: 'Fixer' },
    });

    await service.onRunFinished('run-triage');

    expect(transitionTo).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(runTrigger.trigger).not.toHaveBeenCalled();
    expect(humanTasks.createNonBlocking).toHaveBeenCalledTimes(1);
    const [, task] = (humanTasks.createNonBlocking as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(task.details)).toMatch(/Fixer/);
    expect(String(task.details)).toMatch(/run-busy/);
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker?.payload).toMatchObject({ orchestrator_decision: 'override_active_run' });
  });

  it('race remnant: trigger dedups mid-flight → override_active_run task noting Jira already written', async () => {
    const { service, runTrigger, humanTasks, transitionTo, inserted } = setup({
      triggerDeduplicated: true,
    });

    await service.onRunFinished('run-triage');

    // Jira writes happened first (the ordering); the dedup surfaced after.
    expect(transitionTo).toHaveBeenCalledWith('BRIG-1', 'In Progress');
    expect(runTrigger.trigger).toHaveBeenCalledTimes(1);
    expect(humanTasks.createNonBlocking).toHaveBeenCalledTimes(1);
    const [, task] = (humanTasks.createNonBlocking as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(task.details)).toMatch(/had already been applied/);
    expect(String(task.details)).toMatch(/r-x/);
    // Not a staged error — no error event.
    expect(inserted.filter((i) => i.type === 'error')).toHaveLength(0);
    const marker = inserted.find((i) => i.type === 'jira_action');
    expect(marker?.payload).toMatchObject({ orchestrator_decision: 'override_active_run' });
  });
});
