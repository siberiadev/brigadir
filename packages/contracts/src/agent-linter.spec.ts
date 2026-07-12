import { describe, it, expect } from 'vitest';
import { lintAgent, type BoardStatus, type LintableAgent } from './agent-linter';

const board: BoardStatus[] = [
  { id: '1', name: 'Ready for Dev', statusCategory: 'new' },
  { id: '2', name: 'In Progress', statusCategory: 'indeterminate' },
  { id: '3', name: 'In Review', statusCategory: 'indeterminate' },
  { id: '4', name: 'Blocked', statusCategory: 'indeterminate' },
  { id: '5', name: 'Done', statusCategory: 'done' },
];

function agent(over: Partial<LintableAgent> = {}): LintableAgent {
  return {
    name: 'Implementer',
    trigger_status: 'Ready for Dev',
    trigger_jql: null,
    status_running: 'In Progress',
    status_success: 'In Review',
    status_failure: 'Blocked',
    ...over,
  };
}

describe('lintAgent (T120)', () => {
  it('passes a clean agent with all statuses on the board', () => {
    const { errors, warnings } = lintAgent(agent(), [], board);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('status_absent: a missing status → error pinned to the offending field', () => {
    const { errors } = lintAgent(agent({ status_success: 'Done Done' }), [], board);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('status_absent');
    expect(errors[0].path).toEqual(['status_success']);
    expect(errors[0].value).toBe('Done Done');
    expect(errors[0].level).toBe('error');
  });

  it('duplicate_trigger: an enabled agent sharing trigger_status (no distinguishing jql) → error', () => {
    const existing = agent({ id: 'a1', name: 'QA' });
    const { errors } = lintAgent(agent({ id: 'a2' }), [existing], board);
    expect(errors.some((e) => e.code === 'duplicate_trigger')).toBe(true);
    const dup = errors.find((e) => e.code === 'duplicate_trigger')!;
    expect(dup.path).toEqual(['trigger_status']);
  });

  it('duplicate_trigger: the same collision with a distinct trigger_jql → NO error', () => {
    const existing = agent({ id: 'a1', name: 'QA', trigger_jql: 'labels = urgent' });
    const { errors } = lintAgent(
      agent({ id: 'a2', trigger_jql: 'labels = routine' }),
      [existing],
      board,
    );
    expect(errors.some((e) => e.code === 'duplicate_trigger')).toBe(false);
  });

  it('duplicate_trigger: a DISABLED agent sharing trigger_status → NO error (edge case)', () => {
    const disabled = agent({ id: 'a1', name: 'QA', enabled: false });
    const { errors } = lintAgent(agent({ id: 'a2' }), [disabled], board);
    expect(errors.some((e) => e.code === 'duplicate_trigger')).toBe(false);
  });

  it('editing the same agent does not flag itself as a duplicate', () => {
    const self = agent({ id: 'a1' });
    const { errors } = lintAgent(self, [self], board);
    expect(errors.some((e) => e.code === 'duplicate_trigger')).toBe(false);
  });

  it('status_cycle: a two-agent cycle → one warning and zero errors', () => {
    // A: Ready for Dev → success In Review ; B triggers on In Review → success Ready for Dev
    const b = agent({
      id: 'b',
      name: 'Reviewer',
      trigger_status: 'In Review',
      status_success: 'Ready for Dev',
    });
    const a = agent({ id: 'a' });
    const { errors, warnings } = lintAgent(a, [b], board);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('status_cycle');
    expect(warnings[0].path).toEqual(['status_success']);
    expect(warnings[0].level).toBe('warning');
  });
});
