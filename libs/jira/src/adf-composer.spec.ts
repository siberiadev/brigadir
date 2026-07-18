import { describe, it, expect } from 'vitest';
import type { AgentReport } from '@brigadir/contracts';
import { buildRunComment, buildHumanTaskComment } from './adf-composer';

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

  // --- feature 019: per-repo artifact lines (net-new rendering) ---

  it('renders one artifact line per repos[] entry after the checks taskList', () => {
    const doc = buildRunComment({
      ...base,
      schema_version: 2,
      artifacts: {
        repos: [
          {
            repo: 'lib',
            branch: 'feat/BRIG-1',
            pr_url: 'https://git.example.com/lib/pull/7',
            commits: ['abc', 'def'],
            files_changed: 3,
          },
          { repo: 'consumer', branch: 'feat/BRIG-1' },
        ],
      },
    });
    expect(doc).toMatchSnapshot();
    const text = JSON.stringify(doc);
    expect(text).toContain('lib: feat/BRIG-1 — https://git.example.com/lib/pull/7 (2 commits, 3 files)');
    expect(text).toContain('consumer: feat/BRIG-1');
  });

  it('renders a legacy flat report as one line without a repo prefix (US2)', () => {
    const doc = buildRunComment({
      ...base,
      artifacts: { branch: 'feat/BRIG-1', pr_url: 'https://git/pr/1', commits: ['abc'], files_changed: 1 },
    });
    const text = JSON.stringify(doc);
    expect(text).toContain('feat/BRIG-1 — https://git/pr/1 (1 commit, 1 file)');
  });

  it('a report without artifacts renders no artifact list (byte-identical to pre-019)', () => {
    const doc = buildRunComment(base);
    expect(JSON.stringify(doc)).not.toContain('bulletList');
  });

  it('repos[] is authoritative — flat fields in the same report are not double-rendered', () => {
    const doc = buildRunComment({
      ...base,
      artifacts: { branch: 'flat-branch', repos: [{ repo: 'lib', branch: 'feat/BRIG-1' }] },
    });
    const text = JSON.stringify(doc);
    expect(text).toContain('lib: feat/BRIG-1');
    expect(text).not.toContain('flat-branch');
  });
});

describe('buildHumanTaskComment (T101)', () => {
  it('renders a blocking question with details', () => {
    const doc = buildHumanTaskComment({ kind: 'question', title: 'Which auth flow?', details: 'OAuth or API token?' });
    expect(doc).toMatchSnapshot();
  });

  it('renders without details when omitted', () => {
    const doc = buildHumanTaskComment({ kind: 'blocker', title: 'Missing credentials' });
    expect(doc.content).toHaveLength(2);
  });

  // --- feature 013: suggested answer options as a plain list ---

  it('renders answer options as a bullet list (label — description; value never rendered)', () => {
    const doc = buildHumanTaskComment({
      kind: 'question',
      title: 'Which migration strategy?',
      details: 'The config format change can break older readers.',
      options: [
        { label: 'Migrate config format', value: 'migrate', description: 'Breaking, needs a major bump' },
        { label: 'Keep backward compat' },
      ],
    });
    expect(doc).toMatchSnapshot();
    const text = JSON.stringify(doc);
    expect(text).toContain('Suggested answers:');
    expect(text).toContain('Migrate config format — Breaking, needs a major bump');
    expect(text).not.toContain('"migrate"'); // value is machine-facing only
  });

  it('a task without options is byte-identical to the pre-013 document', () => {
    const doc = buildHumanTaskComment({ kind: 'question', title: 'Which auth flow?', details: 'OAuth or API token?' });
    // Same shape the pre-013 snapshot pinned: panel + title + details, nothing appended.
    expect(doc.content).toHaveLength(3);
    expect(doc).toMatchSnapshot();
  });
});
