import { describe, it, expect, vi } from 'vitest';
import { schema } from '@brigadir/database';
import type { JiraClient } from '@brigadir/jira';
import { HumanTaskService } from './human-task.service';

interface FakeState {
  run: { workspaceId: string; ticketId: string; agentId: string } | undefined;
  runStatus: string;
  /** Open tasks on the run — the dedup probe matches on the query's own blocking filter. */
  openTasks: { id: string; blocking: boolean }[];
  agent: { statusFailure: string } | undefined;
  ticket: { jiraKey: string } | undefined;
  insertedHumanTasks: unknown[];
  insertedRunEvents: unknown[];
}

/**
 * Extract boolean bind params from a drizzle condition (SXF-1174 Problem 7):
 * the dedup query MUST carry `eq(humanTasks.blocking, <bool>)` — the fake
 * answers the probe with that filter applied, so a query missing the filter
 * (the old "any open task" shape) would match the wrong-blocking-ness task
 * and fail the test.
 */
function boolParams(cond: unknown): boolean[] {
  const out: boolean[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.value === 'boolean') out.push(rec.value);
    if (Array.isArray(rec.queryChunks)) rec.queryChunks.forEach(walk);
  };
  walk(cond);
  return out;
}

function fakeDb(state: FakeState): unknown {
  return {
    select: (_cols: unknown) => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => ({
          limit: async (_n: number) => {
            if (table === schema.runs) return state.run ? [state.run] : [];
            if (table === schema.humanTasks) {
              const [wantBlocking] = boolParams(cond);
              const match = state.openTasks.find(
                (t) => wantBlocking === undefined || t.blocking === wantBlocking,
              );
              return match ? [{ id: match.id }] : [];
            }
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
        if (table === schema.runEvents) state.insertedRunEvents.push(vals);
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
      openTasks: [],
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
      insertedRunEvents: [],
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
      openTasks: [],
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
      insertedRunEvents: [],
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
      openTasks: [{ id: 'ht-existing', blocking: true }],
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
      insertedRunEvents: [],
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
    // The no-op is visible on the timeline (SXF-1174 Problem 7).
    expect(state.insertedRunEvents).toHaveLength(1);
    expect(state.insertedRunEvents[0]).toMatchObject({
      runId: 'run-1',
      type: 'log',
      payload: expect.objectContaining({ deduplicated: true, task_id: 'ht-existing' }),
    });
  });

  /**
   * SXF-1174 Problem 7: the incident ordering. The old guard deduped on "any
   * open task", so the non-blocking FYI filed 40 s earlier swallowed the
   * blocking escalation — no row, no park — and the run fail-closed at exit
   * with the human's question discarded.
   */
  it('an open NON-blocking task does not swallow a blocking escalation: row created, run parked', async () => {
    const state: FakeState = {
      run: { workspaceId: 'ws-1', ticketId: 'tkt-1', agentId: 'agent-1' },
      runStatus: 'running',
      openTasks: [{ id: 'ht-fyi', blocking: false }],
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
      insertedRunEvents: [],
    };
    const jira = fakeJira();
    const service = new HumanTaskService(fakeDb(state) as never, fakeFactory(jira));

    const result = await service.createFromRequest('run-1', {
      kind: 'blocker',
      title: 'No restore path exists — need the actual dump',
      blocking: true,
    });

    expect(result).toEqual({ created: true, blocking: true, mayFinishWithoutComplete: true });
    expect(state.insertedHumanTasks).toHaveLength(1);
    expect(state.runStatus).toBe('awaiting_human');
    expect(jira.transitionTo).toHaveBeenCalledWith('BRIG-1', 'Blocked');
  });

  it('symmetrically, an open blocking task does not swallow a non-blocking FYI', async () => {
    const state: FakeState = {
      run: { workspaceId: 'ws-1', ticketId: 'tkt-1', agentId: 'agent-1' },
      runStatus: 'awaiting_human',
      openTasks: [{ id: 'ht-blocking', blocking: true }],
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
      insertedRunEvents: [],
    };
    const service = new HumanTaskService(fakeDb(state) as never, fakeFactory(fakeJira()));

    const result = await service.createFromRequest('run-1', {
      kind: 'question',
      title: 'FYI while parked',
      blocking: false,
    });

    expect(result).toEqual({ created: true, blocking: false, mayFinishWithoutComplete: false });
    expect(state.insertedHumanTasks).toHaveLength(1);
  });

  it('a blocking dedup hit still re-parks a run that somehow stayed running (belt-and-braces)', async () => {
    const state: FakeState = {
      run: { workspaceId: 'ws-1', ticketId: 'tkt-1', agentId: 'agent-1' },
      runStatus: 'running', // anomaly: the blocking task exists but the park was missed
      openTasks: [{ id: 'ht-blocking', blocking: true }],
      agent: { statusFailure: 'Blocked' },
      ticket: { jiraKey: 'BRIG-1' },
      insertedHumanTasks: [],
      insertedRunEvents: [],
    };
    const jira = fakeJira();
    const service = new HumanTaskService(fakeDb(state) as never, fakeFactory(jira));

    const result = await service.createFromRequest('run-1', {
      kind: 'question',
      title: 'Repeat question',
      blocking: true,
    });

    expect(result.created).toBe(false);
    expect(state.insertedHumanTasks).toHaveLength(0);
    expect(state.runStatus).toBe('awaiting_human');
    // Dedup hit does NOT re-transition Jira (the original creation did).
    expect(jira.transitionTo).not.toHaveBeenCalled();
  });
});

describe('HumanTaskService.hasOpenBlockingTask (SXF-1174 Problem 7)', () => {
  function stateWith(openTasks: { id: string; blocking: boolean }[]): FakeState {
    return {
      run: undefined,
      runStatus: 'running',
      openTasks,
      agent: undefined,
      ticket: undefined,
      insertedHumanTasks: [],
      insertedRunEvents: [],
    };
  }

  it('true only for an open BLOCKING task', async () => {
    const blocking = new HumanTaskService(
      fakeDb(stateWith([{ id: 'ht-1', blocking: true }])) as never,
      fakeFactory(fakeJira()),
    );
    expect(await blocking.hasOpenBlockingTask('run-1')).toBe(true);

    const nonBlocking = new HumanTaskService(
      fakeDb(stateWith([{ id: 'ht-2', blocking: false }])) as never,
      fakeFactory(fakeJira()),
    );
    expect(await nonBlocking.hasOpenBlockingTask('run-1')).toBe(false);

    const none = new HumanTaskService(fakeDb(stateWith([])) as never, fakeFactory(fakeJira()));
    expect(await none.hasOpenBlockingTask('run-1')).toBe(false);
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
