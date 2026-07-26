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
    getActiveSprintIds: vi.fn(),
    getTransitions: vi.fn(),
    transitionTo: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as JiraClient;
}

/** The service now takes the per-workspace factory (feature 006 checkpoint). */
function fakeFactory(jira: JiraClient) {
  return { forWorkspace: vi.fn().mockResolvedValue(jira) } as never;
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
    const service = new HumanTaskService(fakeDb(state) as never, fakeFactory(jira));

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
    const service = new HumanTaskService(fakeDb(state) as never, fakeFactory(jira));

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
    const service = new HumanTaskService(fakeDb(state) as never, fakeFactory(jira));

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

/**
 * Feature 032 (T023): title-keyed dedup for the inheritance diagnostics. The
 * feature-022 guard ("any open run-less task on this ticket") is too coarse
 * here — one dependent can legitimately need a lost-branch notice for `api`
 * AND an unmounted-repo notice for `web` at the same time.
 */
describe('HumanTaskService.createTicketBlockedKeyed (feature 032)', () => {
  function keyedDb(openTitles: string[]) {
    const inserted: { title: string }[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => ({
            limit: async () => {
              // The stub cannot read the drizzle condition, so the title being
              // probed is passed through this closure by the caller below.
              void cond;
              return probe.hit ? [{ id: 'ht-1' }] : [];
            },
          }),
        }),
      }),
      insert: () => ({
        values: async (v: { title: string }) => {
          inserted.push(v);
          openTitles.push(v.title);
        },
      }),
    };
    const probe = { hit: false };
    const service = new HumanTaskService(db as never, {} as never);
    const create = async (title: string, details?: string) => {
      probe.hit = openTitles.includes(title);
      return service.createTicketBlockedKeyed('ws-1', 't-1', { title, details });
    };
    return { create, inserted };
  }

  it('creates one task per distinct title', async () => {
    const h = keyedDb([]);
    expect(await h.create('[blocker_branch_lost] T: no usable branch from B for api')).toEqual({
      created: true,
    });
    expect(await h.create('[blocker_repo_unmounted] T: blocker B has work in unmounted web')).toEqual(
      { created: true },
    );
    expect(h.inserted).toHaveLength(2);
  });

  it('deduplicates an identical title — a repeated run adds no second row', async () => {
    const h = keyedDb([]);
    const title = '[blocker_branch_lost] T: no usable branch from B for api';
    expect(await h.create(title)).toEqual({ created: true });
    expect(await h.create(title)).toEqual({ created: false });
    expect(h.inserted).toHaveLength(1);
  });

  it('a different repository in the title is a different task', async () => {
    const h = keyedDb([]);
    await h.create('[blocker_branch_lost] T: no usable branch from B for api');
    expect(await h.create('[blocker_branch_lost] T: no usable branch from B for web')).toEqual({
      created: true,
    });
    expect(h.inserted).toHaveLength(2);
  });

  it('writes a non-blocking, run-less `blocker` task (kind stays the contract enum value)', async () => {
    const h = keyedDb([]);
    await h.create('[blocker_branch_lost] T: no usable branch from B for api', '**details**');
    expect(h.inserted[0]).toMatchObject({
      workspaceId: 'ws-1',
      ticketId: 't-1',
      runId: null,
      kind: 'blocker',
      blocking: false,
      status: 'open',
      details: '**details**',
    });
  });
});
