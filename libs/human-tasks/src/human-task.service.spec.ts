import { describe, it, expect, vi } from 'vitest';
import { schema } from '@brigadir/database';
import type { JiraClient } from '@brigadir/jira';
import { HumanTaskService } from './human-task.service';

interface FakeState {
  run: { workspaceId: string; ticketId: string; agentId: string } | undefined;
  runStatus: string;
  openHumanTaskExists: boolean;
  agent: { statusFailure: string } | undefined;
  ticket: { jiraKey: string } | undefined;
  insertedHumanTasks: unknown[];
}

function fakeDb(state: FakeState): unknown {
  return {
    select: (_cols: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => {
            if (table === schema.runs) return state.run ? [state.run] : [];
            if (table === schema.humanTasks) return state.openHumanTaskExists ? [{ id: 'ht-existing' }] : [];
            if (table === schema.agents) return state.agent ? [state.agent] : [];
            if (table === schema.tickets) return state.ticket ? [state.ticket] : [];
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (vals: unknown) => {
        if (table === schema.humanTasks) state.insertedHumanTasks.push(vals);
      },
    }),
    update: (table: unknown) => ({
      set: (vals: { status: string }) => ({
        where: (_cond: unknown) => ({
          returning: async (_r: unknown) => {
            if (table === schema.runs && state.runStatus === 'running') {
              state.runStatus = vals.status;
              return [{ id: 'run-1' }];
            }
            return [];
          },
        }),
      }),
    }),
  };
}

function fakeJira(): JiraClient {
  return {
    searchUpdated: vi.fn(),
    getBoard: vi.fn(),
    getActiveSprintId: vi.fn(),
    getTransitions: vi.fn(),
    transitionTo: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as JiraClient;
}

describe('HumanTaskService.createFromRequest (T101)', () => {
  it('blocking create: inserts one task, parks the run, transitions + comments', async () => {
    const state: FakeState = {
      run: { workspaceId: 'ws-1', ticketId: 'tkt-1', agentId: 'agent-1' },
      runStatus: 'running',
      openHumanTaskExists: false,
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
    };
    const jira = fakeJira();
    const service = new HumanTaskService(fakeDb(state) as never, jira);

    const result = await service.createFromRequest('run-1', {
      kind: 'question',
      title: 'Which auth flow?',
      details: 'OAuth or API token?',
      blocking: true,
    });

    expect(result).toEqual({ created: true, blocking: true, mayFinishWithoutComplete: true });
    expect(state.insertedHumanTasks).toHaveLength(1);
    expect(state.runStatus).toBe('awaiting_human');
    expect(jira.transitionTo).toHaveBeenCalledWith('BRIG-1', 'Blocked');
    expect(jira.addComment).toHaveBeenCalledTimes(1);
  });

  it('non-blocking create: inserts one task, run stays running, no Jira call', async () => {
    const state: FakeState = {
      run: { workspaceId: 'ws-1', ticketId: 'tkt-1', agentId: 'agent-1' },
      runStatus: 'running',
      openHumanTaskExists: false,
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
    };
    const jira = fakeJira();
    const service = new HumanTaskService(fakeDb(state) as never, jira);

    const result = await service.createFromRequest('run-1', {
      kind: 'question',
      title: 'FYI only',
      blocking: false,
    });

    expect(result).toEqual({ created: true, blocking: false, mayFinishWithoutComplete: false });
    expect(state.insertedHumanTasks).toHaveLength(1);
    expect(state.runStatus).toBe('running');
    expect(jira.transitionTo).not.toHaveBeenCalled();
    expect(jira.addComment).not.toHaveBeenCalled();
  });

  it('a second blocking create for the same run does not add a second open task (FR-020)', async () => {
    const state: FakeState = {
      run: { workspaceId: 'ws-1', ticketId: 'tkt-1', agentId: 'agent-1' },
      runStatus: 'awaiting_human', // already parked by the first call
      openHumanTaskExists: true,
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
    };
    const jira = fakeJira();
    const service = new HumanTaskService(fakeDb(state) as never, jira);

    const result = await service.createFromRequest('run-1', {
      kind: 'question',
      title: 'Another question',
      blocking: true,
    });

    expect(result.created).toBe(false);
    expect(state.insertedHumanTasks).toHaveLength(0);
    expect(jira.transitionTo).not.toHaveBeenCalled();
  });
});
