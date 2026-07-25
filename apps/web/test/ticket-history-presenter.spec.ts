import { describe, it, expect } from 'vitest';
import type { TicketHistoryRun } from '@brigadir/contracts';
import { presentHistory, triggerLabel } from '../src/components/TicketHistory/presenter';

let seq = 0;
function makeRun(overrides: Partial<TicketHistoryRun> & { run_id: string }): TicketHistoryRun {
  seq += 1;
  return {
    agent: { id: 'a1', name: 'Vega', key: 'vega-developer', role: 'Developer', is_orchestrator: false },
    executor_type: 'mock',
    status: 'succeeded',
    outcome: 'success',
    attempt: 1,
    created_at: `2026-07-24T13:0${seq % 10}:00.000Z`,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    cost_usd: null,
    trigger: { source: 'poll', failing_run_id: null, deciding_run_id: null, target_agent: null },
    summary: null,
    routing: null,
    failed_checks: [],
    human_tasks: [],
    ...overrides,
  };
}

const brigadir = {
  id: 'a9',
  name: 'Brigadir',
  key: 'brigadir',
  role: 'Teamlead',
  is_orchestrator: true,
};

describe('presentHistory', () => {
  it('keeps a linear poll-driven pass as plain run blocks', () => {
    const vm = presentHistory([makeRun({ run_id: 'r1' }), makeRun({ run_id: 'r2' })]);
    expect(vm.blocks.map((b) => b.kind)).toEqual(['run', 'run']);
  });

  it('groups triage + rework into one cycle keyed by causal refs (ST3-893 shape)', () => {
    const runs = [
      makeRun({ run_id: 'plan' }),
      makeRun({ run_id: 'dev' }),
      makeRun({ run_id: 'qa1', status: 'failed', outcome: 'failure' }),
      makeRun({
        run_id: 'triage1',
        agent: brigadir,
        outcome: 'routed',
        trigger: { source: 'triage', failing_run_id: 'qa1', deciding_run_id: null, target_agent: null },
        routing: { target_agent: 'vega-developer', task: 'Fix the defects.' },
      }),
      makeRun({
        run_id: 'rework1',
        trigger: { source: 'rework', failing_run_id: 'qa1', deciding_run_id: 'triage1', target_agent: 'vega-developer' },
      }),
      makeRun({ run_id: 'qa2' }),
    ];
    const vm = presentHistory(runs);
    expect(vm.blocks.map((b) => b.kind)).toEqual(['run', 'run', 'run', 'cycle', 'run']);
    const cycle = vm.blocks[3];
    if (cycle.kind !== 'cycle') throw new Error('expected cycle');
    expect(cycle.index).toBe(1);
    expect(cycle.triage.run_id).toBe('triage1');
    expect(cycle.reworks.map((r) => r.run_id)).toEqual(['rework1']);
  });

  it('numbers multiple cycles sequentially', () => {
    const runs = [
      makeRun({ run_id: 'qa1', status: 'failed', outcome: 'failure' }),
      makeRun({
        run_id: 't1',
        agent: brigadir,
        outcome: 'routed',
        trigger: { source: 'triage', failing_run_id: 'qa1', deciding_run_id: null, target_agent: null },
      }),
      makeRun({
        run_id: 'w1',
        trigger: { source: 'rework', failing_run_id: 'qa1', deciding_run_id: 't1', target_agent: null },
      }),
      makeRun({ run_id: 'qa2', status: 'failed', outcome: 'failure' }),
      makeRun({
        run_id: 't2',
        agent: brigadir,
        outcome: 'routed',
        trigger: { source: 'triage', failing_run_id: 'qa2', deciding_run_id: null, target_agent: null },
      }),
      makeRun({
        run_id: 'w2',
        trigger: { source: 'rework', failing_run_id: 'qa2', deciding_run_id: 't2', target_agent: null },
      }),
    ];
    const vm = presentHistory(runs);
    const cycles = vm.blocks.filter((b) => b.kind === 'cycle');
    expect(cycles.map((c) => (c.kind === 'cycle' ? c.index : -1))).toEqual([1, 2]);
  });

  it('treats answer-triage as a cycle opener', () => {
    const runs = [
      makeRun({ run_id: 'qa', status: 'failed', outcome: 'failure' }),
      makeRun({
        run_id: 'at',
        agent: brigadir,
        outcome: 'routed',
        trigger: { source: 'answer-triage', failing_run_id: 'qa', deciding_run_id: null, target_agent: null },
      }),
      makeRun({
        run_id: 'w',
        trigger: { source: 'rework', failing_run_id: 'qa', deciding_run_id: 'at', target_agent: null },
      }),
    ];
    const vm = presentHistory(runs);
    expect(vm.blocks.map((b) => b.kind)).toEqual(['run', 'cycle']);
  });

  it('degrades gracefully on a broken deciding_run_id (orphan rework → main flow)', () => {
    const runs = [
      makeRun({
        run_id: 'orphan',
        trigger: { source: 'rework', failing_run_id: null, deciding_run_id: 'missing', target_agent: null },
      }),
    ];
    const vm = presentHistory(runs);
    expect(vm.blocks).toEqual([{ kind: 'run', run: runs[0] }]);
  });

  it('handles an empty run list', () => {
    expect(presentHistory([])).toEqual({ blocks: [] });
  });
});

describe('triggerLabel', () => {
  it('falls back to "manual" for legacy rows without a source', () => {
    const run = makeRun({
      run_id: 'x',
      trigger: { source: null, failing_run_id: null, deciding_run_id: null, target_agent: null },
    });
    expect(triggerLabel(run)).toBe('manual');
    expect(triggerLabel(makeRun({ run_id: 'y' }))).toBe('poll');
  });
});
