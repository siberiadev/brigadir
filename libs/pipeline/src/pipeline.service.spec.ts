import { describe, it, expect, vi } from 'vitest';
import type { RunTriggerService } from '@brigadir/runs';
import type { HumanTaskService } from '@brigadir/human-tasks';
import type { JiraClientFactory } from '@brigadir/jira';
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
  // query (`getReworkBudget`) awaits the builder directly.
  function awaitableChain(rows: unknown[]) {
    const c = {
      from: () => c,
      where: () => c,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return c;
  }

  function setup(triggerSource: 'answer-triage' | 'triage') {
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
        if (keys.includes('count')) return awaitableChain([{ count: 2 }]); // budget EXHAUSTED (max 2)
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
});
