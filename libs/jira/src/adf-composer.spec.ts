import { describe, it, expect } from 'vitest';
import type { AgentReport } from '@brigadir/contracts';
import { buildRunComment } from './adf-composer';

const base: AgentReport = {
  schema_version: 1,
  outcome: 'success',
  summary: 'Implemented the ticket and ran tests.',
  checks: [
    { name: 'tests_pass', status: 'pass' },
    { name: 'lint_pass', status: 'warn', reason: '2 warnings' },
  ],
};

describe('buildRunComment (T051)', () => {
  it('renders a success report (info panel + summary + taskList)', () => {
    expect(buildRunComment(base)).toMatchSnapshot();
  });

  it('renders a failure report (error panel)', () => {
    expect(
      buildRunComment({ ...base, outcome: 'failure', checks: [{ name: 'tests_pass', status: 'fail', reason: '3 failing' }] }),
    ).toMatchSnapshot();
  });

  it('renders a needs_human report (warning panel)', () => {
    expect(
      buildRunComment({
        ...base,
        outcome: 'needs_human',
        checks: [{ name: 'design_decision', status: 'skip' }],
        human_task: { kind: 'question', title: 'Which API?', details: 'v1 or v2?' },
      }),
    ).toMatchSnapshot();
  });

  it('is pure — identical input yields identical output', () => {
    expect(buildRunComment(base)).toEqual(buildRunComment(base));
  });
});
