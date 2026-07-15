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
