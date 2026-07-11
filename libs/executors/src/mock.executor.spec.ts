import { describe, it, expect } from 'vitest';
import { schema } from '@brigadir/database';
import { MockExecutor } from './mock.executor';
import { ExecutorRegistry } from './executor.registry';
import type { RunContext } from './agent-executor.interface';

/**
 * T024: each scenario is deterministic across two runs; rate_limited flips on
 * the second call (backed by a `run_events` marker).
 */

interface RunEventRow {
  runId: string;
  type: string;
  payload: unknown;
}

/** Minimal fake BrigadirDb covering the two tables MockExecutor touches. */
function fakeDb(triggerEvent: unknown, runEvents: RunEventRow[]) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            table === schema.runs
              ? Promise.resolve([{ triggerEvent }])
              : Promise.resolve(runEvents.filter((e) => e.type === 'api_retry')),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: RunEventRow) => {
        if (table === schema.runEvents) runEvents.push(v);
        return Promise.resolve();
      },
    }),
  };
}

const ctx = (runId = 'run-1'): RunContext => ({
  runId,
  ticket: { key: 'BRIG-1', summary: '', description: '', url: '' },
  instruction: 'do it',
  workspaceDir: null,
  callback: { httpBaseUrl: 'http://x', runToken: 't' },
  limits: { timeoutMs: 1000 },
  env: {},
});

const signal = new AbortController().signal;

describe('MockExecutor (T024)', () => {
  for (const [scenario, expectedExit] of [
    ['success', 'completed'],
    ['failure', 'completed'],
    ['needs_human', 'completed'],
    ['timeout', 'timeout'],
  ] as const) {
    it(`${scenario} is deterministic across two runs → ${expectedExit}`, async () => {
      const exec = new MockExecutor(fakeDb({ source: 'manual', mock_scenario: scenario }, []) as never);
      const r1 = await exec.run(ctx(), signal);
      const r2 = await exec.run(ctx(), signal);
      expect(r1.exitStatus).toBe(expectedExit);
      expect(r2).toEqual(r1);
    });
  }

  it('crash throws deterministically', async () => {
    const exec = new MockExecutor(fakeDb({ source: 'manual', mock_scenario: 'crash' }, []) as never);
    await expect(exec.run(ctx(), signal)).rejects.toThrow(/crash/);
    await expect(exec.run(ctx(), signal)).rejects.toThrow(/crash/);
  });

  it('absent mock_scenario defaults to success', async () => {
    const exec = new MockExecutor(fakeDb({ source: 'manual' }, []) as never);
    const r = await exec.run(ctx(), signal);
    expect(r.exitStatus).toBe('completed');
    expect((r.report as { outcome: string }).outcome).toBe('success');
  });

  it('rate_limited returns rate_limited first, then success on the retry', async () => {
    const runEvents: RunEventRow[] = [];
    const exec = new MockExecutor(
      fakeDb({ source: 'manual', mock_scenario: 'rate_limited' }, runEvents) as never,
    );
    const first = await exec.run(ctx(), signal);
    expect(first.exitStatus).toBe('rate_limited');
    expect(runEvents).toHaveLength(1);

    const second = await exec.run(ctx(), signal);
    expect(second.exitStatus).toBe('completed');
    expect((second.report as { outcome: string }).outcome).toBe('success');
  });

  it('healthCheck reports ok', async () => {
    const exec = new MockExecutor(fakeDb({}, []) as never);
    expect(await exec.healthCheck()).toEqual({ ok: true });
  });
});

describe('ExecutorRegistry (T022)', () => {
  it('resolves the mock executor by type and reports has()', () => {
    const mock = new MockExecutor(fakeDb({}, []) as never);
    const registry = new ExecutorRegistry([mock]);
    expect(registry.resolve('mock')).toBe(mock);
    expect(registry.has('mock')).toBe(true);
    expect(registry.has('claude_cli')).toBe(false);
    expect(() => registry.resolve('claude_cli')).toThrow(/no executor registered/);
  });
});
