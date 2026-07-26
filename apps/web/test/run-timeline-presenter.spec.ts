import { describe, it, expect } from 'vitest';
import type { RunCardEvent } from '@brigadir/contracts';
import {
  presentEvent,
  presentEvents,
  prettifyToolName,
} from '../src/components/RunTimeline/presenter';

/** feature 026: the parser now persists tool_call `input` as a structured object. */
function toolEvent(name: string, input: Record<string, unknown>, truncated = false, id = 'e-1') {
  return { id, type: 'tool_call', payload: { name, input, truncated }, created_at: '2026-07-12T10:00:05.000Z' };
}

/**
 * Pure presenter units: RunCardEvent → TimelineItem (`time · icon · title` +
 * an always-visible body block). Payload is untyped in the contract, and
 * tool_call.input arrives as a possibly-truncated JSON string — every shape
 * here mirrors what the stream parser actually emits.
 */

function event(type: string, payload: unknown, id = 'e-1'): RunCardEvent {
  return { id, type, payload, created_at: '2026-07-12T10:00:05.000Z' };
}

describe('presentEvent — tool_call', () => {
  it('Bash: title = tool name, body = full command', () => {
    const item = presentEvent(
      event('tool_call', {
        name: 'Bash',
        input: JSON.stringify({ command: 'pnpm test\npnpm lint', description: 'Run checks' }),
      }),
    );
    expect(item.typeKey).toBe('tool_call');
    expect(item.title).toBe('Bash');
    expect(item.body).toBe('pnpm test\npnpm lint');
  });

  it('Edit: body falls back to file_path when there is no command', () => {
    const item = presentEvent(
      event('tool_call', {
        name: 'Edit',
        input: JSON.stringify({ file_path: '/a/b/c.ts', old_string: 'x', new_string: 'y' }),
      }),
    );
    expect(item.title).toBe('Edit');
    expect(item.body).toBe('/a/b/c.ts');
  });

  it('truncated unparseable input becomes the body with an ellipsis, no crash', () => {
    const raw = `{"file_path":"/a/b.ts","content":"${'x'.repeat(500)}`.slice(0, 500);
    const item = presentEvent(event('tool_call', { name: 'Write', input: raw }));
    expect(item.title).toBe('Write');
    expect(item.body?.startsWith('{"file_path"')).toBe(true);
    expect(item.body?.endsWith('…')).toBe(true);
  });

  it('prettifies MCP tool names and uses message as the body', () => {
    expect(prettifyToolName('mcp__jira__report_progress')).toBe('report_progress (jira)');
    expect(prettifyToolName('Bash')).toBe('Bash');
    const item = presentEvent(
      event('tool_call', {
        name: 'mcp__jira__report_progress',
        input: JSON.stringify({ message: 'stage done' }),
      }),
    );
    expect(item.title).toBe('report_progress (jira)');
    expect(item.body).toBe('stage done');
  });
});

describe('presentEvent — other types', () => {
  it('progress: capitalized stage title, message body, percent', () => {
    const item = presentEvent(
      event('progress', { message: 'Implementing', stage: 'implement', percent: 40 }),
    );
    expect(item.title).toBe('Implement');
    expect(item.body).toBe('Implementing');
    expect(item.percent).toBe(40);
  });

  it('progress without a stage is titled Progress', () => {
    const item = presentEvent(event('progress', { message: 'Working on it' }));
    expect(item.title).toBe('Progress');
    expect(item.body).toBe('Working on it');
    expect(item.percent).toBeNull();
  });

  it('log: Session started with a model/tools/mcp summary body', () => {
    const item = presentEvent(
      event('log', {
        model: 'claude-sonnet-5',
        session_id: 's-1',
        tools: ['Bash', 'Edit'],
        mcp_servers: [{ name: 'brigadir', status: 'connected' }],
      }),
    );
    expect(item.title).toBe('Session started');
    expect(item.body).toBe('claude-sonnet-5 · 2 tools · mcp: brigadir (connected)');
  });

  it('log/repo-scoping (feature 020, FR-015): renders the narrowing decision message verbatim', () => {
    const item = presentEvent(
      event('log', {
        source: 'repo-scoping',
        message: 'ticket components narrowed the repository set to: infra (ignored non-repository components: Design)',
        components: ['infra', 'Design'],
        matched: ['infra'],
        ignored: ['Design'],
        effective: ['infra'],
        gate: 'passed',
      }),
    );
    expect(item.title).toBe('Repository scoping');
    expect(item.body).toContain('narrowed the repository set to: infra');
  });

  it('jira_action: composed body', () => {
    const item = presentEvent(event('jira_action', { commented: true, transitioned_to: 'Review' }));
    expect(item.title).toBe('Jira');
    expect(item.body).toBe('commented · → Review');
  });

  it('api_retry: error + attempt + delay body', () => {
    const item = presentEvent(
      event('api_retry', { error: 'overloaded', retry_delay_ms: 2000, attempt: 2 }),
    );
    expect(item.title).toBe('API retry');
    expect(item.body).toBe('overloaded · attempt 2 · retry in 2000ms');
  });

  it('unknown type with an empty payload: raw type title, no body', () => {
    const item = presentEvent(event('started', {}));
    expect(item.typeKey).toBe('unknown');
    expect(item.title).toBe('started');
    expect(item.body).toBeNull();
  });

  it('non-object payloads never crash', () => {
    expect(presentEvent(event('progress', null)).body).toBeNull();
    expect(presentEvent(event('whatever', 'short note')).body).toBe('short note');
    expect(presentEvent(event('whatever', 42)).body).toBe('42');
    expect(presentEvent(event('tool_call', 'not-an-object')).title).toBe('tool_call');
  });
});

describe('presentEvent — body format (feature 026, US1)', () => {
  it('message-like fields (message/details/summary) render as Markdown', () => {
    expect(presentEvent(toolEvent('mcp__jira__report_progress', { message: 'stage done' })).bodyFormat).toBe(
      'markdown',
    );
    expect(
      presentEvent(toolEvent('mcp__brigadir__request_human', { kind: 'question', title: 'T', details: '## Hi' }))
        .bodyFormat,
    ).toBe('markdown');
    const complete = presentEvent(
      toolEvent('mcp__brigadir__complete_task', { outcome: 'success', summary: '- did it' }),
    );
    expect(complete.bodyFormat).toBe('markdown');
    expect(complete.body).toBe('- did it');
  });

  it('a command renders as a monospace block', () => {
    const item = presentEvent(toolEvent('Bash', { command: 'pnpm test' }));
    expect(item.body).toBe('pnpm test');
    expect(item.bodyFormat).toBe('mono');
  });

  it('a Write file-content placeholder renders inline as the body', () => {
    const item = presentEvent(toolEvent('Write', { content: '<file content, 34 KB>' }));
    expect(item.body).toBe('<file content, 34 KB>');
    expect(item.bodyFormat).toBe('mono');
  });

  it('surfaces the truncated flag from the structured payload', () => {
    expect(presentEvent(toolEvent('Grep', { pattern: 'x' }, true)).fieldTruncated).toBe(true);
    expect(presentEvent(toolEvent('Grep', { pattern: 'x' }, false)).fieldTruncated).toBe(false);
  });

  it('a legacy cut string input renders monospace and flags legacyTruncated', () => {
    const raw = `{"file_path":"/a/b.ts","content":"${'x'.repeat(500)}`.slice(0, 500);
    const item = presentEvent({
      id: 'e-legacy',
      type: 'tool_call',
      payload: { name: 'Write', input: raw },
      created_at: '2026-07-12T10:00:05.000Z',
    });
    expect(item.bodyFormat).toBe('mono');
    expect(item.legacyTruncated).toBe(true);
    expect(item.body?.endsWith('…')).toBe(true);
  });
});

describe('presentEvent — orchestrator affordance & typed cards (feature 026, US2/US3)', () => {
  it('report_progress: arrow title, megaphone iconKey, orchestrator flag', () => {
    const item = presentEvent(toolEvent('mcp__brigadir__report_progress', { stage: 's', message: 'working' }));
    expect(item.orchestrator).toBe(true);
    expect(item.iconKey).toBe('report_progress');
    expect(item.title).toBe('report_progress → Brigadir');
    expect(item.body).toBe('working');
    expect(item.bodyFormat).toBe('markdown');
  });

  it('request_human: title from its title, kind + blocking tags, details as Markdown', () => {
    const item = presentEvent(
      toolEvent('mcp__brigadir__request_human', {
        kind: 'question',
        title: 'Clarify empty-input behavior',
        details: '## Context\n- detail',
        blocking: true,
      }),
    );
    expect(item.orchestrator).toBe(true);
    expect(item.iconKey).toBe('request_human');
    expect(item.title).toBe('Clarify empty-input behavior');
    expect(item.tags).toEqual([
      { label: 'question', tone: 'info' },
      { label: 'blocking', tone: 'warning' },
    ]);
    expect(item.body).toBe('## Context\n- detail');
    expect(item.bodyFormat).toBe('markdown');
  });

  it('request_human non-blocking gets a non-blocking tag', () => {
    const item = presentEvent(
      toolEvent('mcp__brigadir__request_human', { kind: 'review', title: 'T', details: 'd', blocking: false }),
    );
    expect(item.tags).toContainEqual({ label: 'non-blocking' });
  });

  it('complete_task: "Complete · outcome" title, summary Markdown, checks-count tag, flag icon', () => {
    const item = presentEvent(
      toolEvent('mcp__brigadir__complete_task', {
        outcome: 'success',
        summary: '- shipped it',
        checks: [{ name: 'a' }, { name: 'b' }],
      }),
    );
    expect(item.title).toBe('Complete · success');
    expect(item.iconKey).toBe('complete_task');
    expect(item.tags).toEqual([{ label: '2 checks', tone: 'info' }]);
    expect(item.body).toBe('- shipped it');
    expect(item.bodyFormat).toBe('markdown');
  });

  it('a non-brigadir MCP tool keeps the "(server)" form and is not an orchestrator call', () => {
    const item = presentEvent(toolEvent('mcp__jira__get_ticket', { key: 'BRIG-1' }));
    expect(item.orchestrator).toBe(false);
    expect(item.title).toBe('get_ticket (jira)');
    expect(item.iconKey).toBe('tool_call');
  });
});

describe('presentEvent — key/value fallback (feature 026, US4)', () => {
  it('a structured input with no primary text field renders as a kv list, not a JSON dump', () => {
    const item = presentEvent(toolEvent('SomeTool', { alpha: 'one', beta: 2, gamma: true }));
    expect(item.bodyFormat).toBe('kv');
    expect(item.body).toBeNull();
    expect(item.kv).toEqual([
      { key: 'alpha', value: 'one' },
      { key: 'beta', value: '2' },
      { key: 'gamma', value: 'true' },
    ]);
  });
});

describe('presentEvents — report_progress dedup', () => {
  it('collapses a report_progress tool_call + progress pair with the same message', () => {
    const items = presentEvents([
      event(
        'tool_call',
        {
          name: 'mcp__brigadir__report_progress',
          input: JSON.stringify({ stage: 'implement', message: 'Working on it', percent: 25 }),
        },
        'e-1',
      ),
      event('progress', { stage: 'implement', message: 'Working on it', percent: 25 }, 'e-2'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('e-2');
    expect(items[0].typeKey).toBe('progress');
    expect(items[0].percent).toBe(25);
  });

  it('keeps a report_progress tool_call whose message differs from the next progress', () => {
    const items = presentEvents([
      event(
        'tool_call',
        { name: 'mcp__brigadir__report_progress', input: JSON.stringify({ message: 'A' }) },
        'e-1',
      ),
      event('progress', { message: 'B' }, 'e-2'),
    ]);
    expect(items).toHaveLength(2);
  });
});

describe('presentEvent — channel_failure (feature 027)', () => {
  const payload = {
    ts: '2026-07-21T10:00:00.000Z',
    tool: 'complete_task',
    kind: 'network',
    attempts: 11,
    error: { name: 'TypeError', message: 'fetch failed' },
    target: '127.0.0.1:3210',
    occurred_at: '2026-07-21T10:00:00.000Z',
    source: 'exit',
  };

  it('renders a kv card: tool, attempts, error, target, occurred_at', () => {
    const item = presentEvent(event('channel_failure', payload));
    expect(item.typeKey).toBe('channel_failure');
    expect(item.title).toBe('Callback channel failure');
    expect(item.bodyFormat).toBe('kv');
    const kv = Object.fromEntries((item.kv ?? []).map((p) => [p.key, p.value]));
    expect(kv['tool']).toBe('complete_task');
    expect(kv['attempts']).toBe('11');
    expect(kv['error']).toBe('TypeError: fetch failed');
    expect(kv['target']).toBe('127.0.0.1:3210');
    expect(kv['when']).toBeTruthy(); // occurred_at, не created_at строки
    expect(item.tags).toEqual([{ label: 'network', tone: 'warning' }]);
  });

  it('http-exhaustion adds the HTTP status row', () => {
    const item = presentEvent(
      event('channel_failure', {
        ...payload,
        kind: 'http',
        attempts: 4,
        status: 502,
        error: { name: 'HTTPError', message: 'HTTP 502' },
      }),
    );
    const kv = Object.fromEntries((item.kv ?? []).map((p) => [p.key, p.value]));
    expect(kv['HTTP']).toBe('502');
    expect(item.tags?.[0]?.label).toBe('http');
  });

  it('malformed payload never crashes and still shows the title', () => {
    const item = presentEvent(event('channel_failure', 'garbage'));
    expect(item.title).toBe('Callback channel failure');
    expect(item.bodyFormat).toBeNull();
    expect(item.kv).toBeNull();
  });
});

/**
 * Feature 032 (T053): the five new start-ref decisions + the early-release
 * annotation. Every one renders as a readable sentence plus a compact kv list
 * and a decision chip — never a JSON dump of the payload (feature-026 rules).
 */
describe('presentEvent — branch inheritance (feature 032)', () => {
  const startRef = (payload: Record<string, unknown>) =>
    presentEvent(event('log', { source: 'start-ref', ...payload }));

  it('inherited_from_blocker: names the repo, the blocker and the branch', () => {
    const item = startRef({
      repo: 'product',
      decision: 'inherited_from_blocker',
      message: 'product: starting from run/ST3-101, inherited from blocker ST3-101',
      continueBranch: 'run/ST3-101',
      startSha: 'abcdef1234567890',
      blockers: [{ key: 'ST3-101', branch: 'run/ST3-101', runId: 'r-1' }],
    });
    expect(item.title).toBe('Start point · product');
    expect(item.body).toContain('inherited from blocker ST3-101');
    expect(item.bodyFormat).toBe('markdown');
    expect(item.tags).toEqual([{ label: 'inherited from blocker', tone: 'info' }]);
    expect(item.kv).toEqual([
      { key: 'branch', value: 'run/ST3-101' },
      { key: 'blockers', value: 'ST3-101 (run/ST3-101)' },
      { key: 'start commit', value: 'abcdef123456' },
    ]);
  });

  it('merged_blockers: lists the merge order and both blockers', () => {
    const item = startRef({
      repo: 'product',
      decision: 'merged_blockers',
      message: 'product: starting from run/A merged with run/B',
      continueBranch: 'run/A',
      mergedBranches: ['run/B'],
      blockers: [
        { key: 'ST3-1', branch: 'run/A', runId: 'r-1' },
        { key: 'ST3-2', branch: 'run/B', runId: 'r-2' },
      ],
    });
    expect(item.tags).toEqual([{ label: 'merged blockers', tone: 'info' }]);
    expect(item.kv).toContainEqual({ key: 'merged', value: 'run/B' });
    expect(item.kv).toContainEqual({ key: 'blockers', value: 'ST3-1 (run/A), ST3-2 (run/B)' });
  });

  it('blocker_branch_merged is a quiet, untoned chip (the normal end of a chain)', () => {
    const item = startRef({
      repo: 'product',
      decision: 'blocker_branch_merged',
      message: 'product: ST3-1 is done and left no branch on origin',
      blockers: [{ key: 'ST3-1', branch: null }],
    });
    expect(item.tags).toEqual([{ label: 'blocker merged', tone: undefined }]);
  });

  it('blocker_no_artifact warns — the run started WITHOUT its blocker work', () => {
    const item = startRef({
      repo: 'product',
      decision: 'blocker_no_artifact',
      message: 'product: ST3-1 is still open (In Review) but left no usable branch',
      blockers: [{ key: 'ST3-1', branch: null }],
    });
    expect(item.tags).toEqual([{ label: 'blocker branch missing', tone: 'warning' }]);
    expect(item.body).toContain('left no usable branch');
  });

  it('blocker_artifacts_unmounted warns and names the repository', () => {
    const item = startRef({
      decision: 'blocker_artifacts_unmounted',
      repo: 'backend',
      message: 'ST3-1 reported work in "backend", which this run does not mount',
      blockers: [{ key: 'ST3-1', branch: 'run/API' }],
    });
    expect(item.title).toBe('Start point · backend');
    expect(item.tags).toEqual([{ label: 'repository not mounted', tone: 'warning' }]);
  });

  it('keeps the feature-023/024 decisions readable', () => {
    const confirmed = startRef({
      repo: 'product',
      decision: 'report_confirmed',
      message: 'product: continuing branch run/OWN, reported by run r-0',
      continueBranch: 'run/OWN',
      startSha: 'deadbeefcafe0000',
    });
    expect(confirmed.tags).toEqual([{ label: 'continues own branch', tone: undefined }]);
    const plain = startRef({
      repo: 'infra',
      decision: 'default_branch',
      message: 'infra: no branch reported by prior work — starting from main',
    });
    expect(plain.tags).toEqual([{ label: 'default branch', tone: undefined }]);
    expect(plain.kv).toBeNull();
  });

  it('early release: names the status that let the dependent start', () => {
    const item = presentEvent(
      event('log', {
        source: 'dependency-release',
        early: true,
        matched_status: 'In Review',
        blockers: [{ key: 'ST3-101', status: 'In Review' }],
        message: 'Released early: blocker(s) [ST3-101] reached "In Review" without being done.',
      }),
    );
    expect(item.title).toBe('Released early');
    expect(item.tags).toEqual([{ label: 'early release', tone: 'info' }]);
    expect(item.kv).toEqual([
      { key: 'released at status', value: 'In Review' },
      { key: 'blockers', value: 'ST3-101 (In Review)' },
    ]);
  });

  it('never renders a raw JSON dump in the body', () => {
    const item = startRef({
      repo: 'product',
      decision: 'inherited_from_blocker',
      message: 'product: starting from run/A',
      blockers: [{ key: 'ST3-1', branch: 'run/A', runId: 'r-1' }],
      startSha: 'abc123',
    });
    expect(item.body).not.toContain('{');
    expect(item.body).not.toContain('runId');
  });
});
