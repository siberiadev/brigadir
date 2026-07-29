import { describe, it, expect } from 'vitest';
import type { RunContext } from '../agent-executor.interface';
import { buildWrapperText } from './wrapper';

const ctx: RunContext = {
  runId: 'run-1',
  ticket: { key: 'BRIG-1', summary: 'Do the thing', description: 'Some description', url: '' },
  instruction: 'Implement the feature.',
  workspaceDir: null,
  callback: { httpBaseUrl: 'http://localhost:3000/api/callbacks', runToken: 'tok' },
  limits: { timeoutMs: 60_000 },
  env: {},
};

describe('buildWrapperText (T103, D6)', () => {
  it('structured-output path (useCallbackChannel:false): tells the agent to return JSON, no MCP tool names', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: false });
    expect(text).toContain('return your final answer strictly as JSON');
    expect(text).not.toContain('mcp__brigadir__');
  });

  it('callback path (useCallbackChannel:true): names all three MCP tools as the only voice', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).toContain('mcp__brigadir__report_progress');
    expect(text).toContain('mcp__brigadir__request_human');
    expect(text).toContain('mcp__brigadir__complete_task');
    expect(text).not.toContain('return your final answer strictly as JSON');
  });

  it('callback path instructs the agent to fail-fast on persistent MCP network failure', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).toContain('MCP callback channel unreachable');
    expect(text).toContain('blocking=true');
    expect(text).toContain('network error');
    expect(text).toContain('fetch failed');
  });

  it('callback path forbids sleep-loop recovery tactics', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).toContain('ScheduleWakeup');
    expect(text).toContain('Bash sleep');
    expect(text).toContain('until false');
  });

  // Token-spend problem 1 (analysis 2026-07-28): the prohibition covers ANY
  // precondition, not just infrastructure recovery, and names both
  // session-ending exits.
  it('callback path bans in-session waiting for any precondition and names the exit paths', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).toContain('Never wait in-session for ANY precondition');
    expect(text).toContain('blocked by the harness');
    expect(text).toContain('mcp__brigadir__request_human(blocking=true');
    expect(text).toContain('mcp__brigadir__complete_task(outcome="failure" or "needs_human")');
    expect(text).toContain('restarts the run when the condition holds');
  });

  it('structured-output path does not contain callback-channel fail-fast rules', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: false });
    expect(text).not.toContain('MCP callback channel unreachable');
    expect(text).not.toContain('ScheduleWakeup');
  });

  // Problem 4 (incident 2026-07-19): QA/verification runs must not boot a full
  // dev stack inside the run. Callback channel only.
  it('callback path includes the QA/verification restriction on full dev-stack boots', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).toContain('## Verification and QA');
    expect(text).toContain('docker compose up');
    expect(text).toContain('npm ci');
    expect(text).toContain('start:dev');
    expect(text).toContain('5 minutes');
    // Prefer cheap verification over live stacks.
    expect(text).toContain('unit tests');
    expect(text).toContain('static analysis');
    // Reachability check before booting anything, else escalate to a human.
    expect(text).toContain('ALREADY running and reachable');
    expect(text).toContain("request_human(blocking=true, title='Live test environment unavailable'");
  });

  it('structured-output path does not contain the QA/verification section (Phase-0 byte-identical)', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: false });
    expect(text).not.toContain('## Verification and QA');
    expect(text).not.toContain('docker compose up');
  });

  // feature 013: agents discover answer options from the wrapper alone —
  // stored instructions stay untouched. The Phase-0 section keeps its
  // byte-for-byte contract, so options are never mentioned there.
  it('callback path mentions request_human options; structured-output path does not', () => {
    const callbackText = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(callbackText).toContain('options: [{label, value?, description?}]');
    expect(callbackText).toContain('a choice, not an essay');

    const phase0Text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: false });
    expect(phase0Text).not.toContain('options: [{label');
  });

  it('includes the ticket key/summary and instruction in both paths', () => {
    for (const useCallbackChannel of [false, true]) {
      const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel });
      expect(text).toContain('BRIG-1');
      expect(text).toContain('Do the thing');
      expect(text).toContain('Implement the feature.');
      expect(text).toContain('/tmp/wt');
    }
  });

  it('appends the feature-context section when provided (US6)', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      featureContextSection: '## Feature context\n- BRIG-9 [Done] sibling issue',
    });
    expect(text).toContain('## Feature context');
    expect(text).toContain('BRIG-9');
  });

  it('omits the feature-context section when not provided', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).not.toContain('## Feature context');
  });

  // feature 011 (D4): ticketless workspace-setup runs get the orchestrator
  // header — no ticket key, no Jira-ticket framing; the setup handoff (already
  // prepended to `instruction`) carries the digest and protocol.
  it('ticketless run: renders the workspace-setup header instead of the ticket header', () => {
    const setupCtx: RunContext = { ...ctx, ticket: null, instruction: 'Propose the team.' };
    const text = buildWrapperText(setupCtx, '/tmp/wt', { useCallbackChannel: true });
    expect(text).toContain('workspace orchestrator');
    expect(text).toContain('There is no Jira ticket for this run.');
    expect(text).toContain('Propose the team.');
    expect(text).not.toContain('BRIG-1');
    expect(text).not.toContain('working on Jira ticket');
  });

  // Feature 019 (spec FR-013, research D9): the Repositories section.
  describe('repositories section (feature 019)', () => {
    const repos = [
      {
        name: 'lib',
        absPath: '/wt/run-1/lib',
        defaultBranch: 'main',
      },
      {
        name: 'consumer',
        absPath: '/wt/run-1/consumer',
        defaultBranch: 'develop',
      },
    ];

    // Feature 024 (US2): the wrapper no longer proposes a system-invented
    // branch name — a first stage names its own branch (spec-kit convention).
    it('lists every prepared repo with absolute path and base branch, and proposes no branch name', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      expect(text).toContain('## Repositories');
      expect(text).toContain('DETACHED HEAD');
      expect(text).toContain('- lib: /wt/run-1/lib (no prior branch; at main)');
      expect(text).toContain('- consumer: /wt/run-1/consumer (no prior branch; at develop)');
      // No system-suggested branch name anywhere in the section.
      expect(text).not.toContain('create feat/BRIG-1');
      expect(text).not.toMatch(/no prior branch; at \w+ — create/);
    });

    it('tells the agent to create a branch of its own choosing when there is no prior branch', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      expect(text).toContain('create a branch of your own choosing');
    });

    // Feature 023: the stage handoff. A repo whose branch a previous stage
    // reported is presented as work to continue, not as a fresh start.
    it('presents a continue branch when a previous stage reported one', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', {
        useCallbackChannel: true,
        repos: [{ ...repos[0], continueBranch: 'run/BRIG-1' }],
      });
      expect(text).toContain('- lib: /wt/run-1/lib (continue branch run/BRIG-1, based on main)');
      expect(text).toContain('never start a competing branch');
    });

    it('tells the agent to branch before committing and that the next stage reads its report', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      expect(text).toContain('`git switch -C <branch>`');
      expect(text).toContain('Never commit on the detached HEAD');
      expect(text).toContain('The next stage on this ticket starts from the branch you report here');
    });

    it('carries the four FR-013 conduct rules + touched-repos-only checks', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      expect(text).toContain('Decide from the ticket which of these repositories actually need changes');
      expect(text).toContain('Commit and push only in repositories you actually changed');
      expect(text).toContain("reference each dependent PR in the other PR's description");
      expect(text).toContain('Run the required checks/tests inside each repository you changed (and only there)');
      expect(text).toContain('one entry per CHANGED repository');
      expect(text).toContain('schema_version: 2');
    });

    it('points the report target at complete_task on the callback channel and at the JSON report on Phase 0', () => {
      const callbackText = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      expect(callbackText).toContain('artifacts.repos` array of your complete_task call');

      const phase0Text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: false, repos });
      expect(phase0Text).toContain('artifacts.repos` array of your final JSON report');
    });

    it('single-repo runs get the section too (uniform layout — the wrapper names the repo path)', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos: [repos[0]] });
      expect(text).toContain('## Repositories');
      expect(text).toContain('- lib: /wt/run-1/lib');
    });

    it('feature 020 (D4): a narrowed run lists excluded repos with the .repos/<name> on-demand note', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', {
        useCallbackChannel: true,
        repos: [repos[0]],
        onDemandRepos: [{ name: 'backend', url: 'git@acme:backend.git' }],
      });
      expect(text).toContain('were NOT mounted');
      expect(text).toContain('`.repos/<name>`');
      expect(text).toContain('- backend: git@acme:backend.git');
    });

    it('feature 020: a NON-narrowed run renders byte-identical to the feature-019 wrapper', () => {
      const before = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      const withEmpty = buildWrapperText(ctx, '/wt/run-1', {
        useCallbackChannel: true,
        repos,
        onDemandRepos: [],
      });
      expect(withEmpty).toBe(before);
      expect(before).not.toContain('.repos/<name>');
    });

    it('no-repo runs (repos absent or empty): wrapper is byte-identical to the pre-019 form', () => {
      const without = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true });
      const withEmpty = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true, repos: [] });
      expect(withEmpty).toBe(without);
      expect(without).not.toContain('## Repositories');
    });
  });
});

/**
 * Feature 032 (T022/T047): per-repository provenance lines + the
 * `## Linked tickets` block. Both state FACTS (D7) — the agent is never told to
 * merge or chase a blocker — and both are absent, byte-identically, when the
 * run inherited nothing (FR-016).
 */
describe('buildWrapperText — blocker provenance (feature 032)', () => {
  const base = { name: 'product', absPath: '/wt/product', defaultBranch: 'main' };

  it('labels an inherited repository as a DEPENDENCY and names the blocker', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [
        {
          ...base,
          continueBranch: 'run/ST3-101',
          provenance: 'inherited_blocker',
          blockerKey: 'ST3-101',
        },
      ],
    });
    expect(text).toContain(
      '- product: /wt/product (DEPENDENCY — branch run/ST3-101 from ST3-101, not yet in main;',
    );
    expect(text).toContain('do not modify it unless the task says so');
  });

  it('states the merged start point and the PR base for a diamond', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [
        {
          ...base,
          continueBranch: 'run/A',
          provenance: 'merged_blockers',
          mergedFrom: [
            { key: 'ST3-1', branch: 'run/A' },
            { key: 'ST3-2', branch: 'run/B' },
          ],
        },
      ],
    });
    expect(text).toContain('continues run/A from ST3-1 merged with run/B from ST3-2');
    expect(text).toContain('already in your start point');
    expect(text).toContain('open your PR against run/A, not main');
  });

  it('keeps the default and continue-own lines byte-identical to feature 023', () => {
    const legacy = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [base, { ...base, name: 'infra', absPath: '/wt/infra', continueBranch: 'run/OWN' }],
    });
    expect(legacy).toContain('- product: /wt/product (no prior branch; at main)');
    expect(legacy).toContain('- infra: /wt/infra (continue branch run/OWN, based on main)');
    // An explicit provenance produces the same text as the inferred one.
    const explicit = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [
        { ...base, provenance: 'default' },
        {
          ...base,
          name: 'infra',
          absPath: '/wt/infra',
          continueBranch: 'run/OWN',
          provenance: 'continue_own',
        },
      ],
    });
    expect(explicit).toBe(legacy);
  });

  it('renders the Linked tickets block on both channels', () => {
    const opts = {
      repos: [base],
      linkedTickets: [
        { key: 'ST3-101', status: 'In Review', branch: 'run/ST3-101', prUrl: 'https://x/pr/1' },
      ],
    };
    for (const useCallbackChannel of [true, false]) {
      const text = buildWrapperText(ctx, '/tmp/wt', { ...opts, useCallbackChannel });
      expect(text).toContain('## Linked tickets');
      expect(text).toContain('- ST3-101 [In Review] branch: run/ST3-101 PR: https://x/pr/1');
    }
  });

  it('sorts blockers by key and omits absent branch/PR fields', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [base],
      linkedTickets: [
        { key: 'ST3-9', status: 'Done' },
        { key: 'ST3-2', status: 'In Review', branch: 'run/B' },
      ],
    });
    const lines = text.split('\n').filter((l) => l.startsWith('- ST3-'));
    expect(lines).toEqual(['- ST3-2 [In Review] branch: run/B', '- ST3-9 [Done]']);
  });

  it('caps the block at 10 entries and says how many were omitted', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      key: `ST3-${String(i + 10).padStart(3, '0')}`,
      status: 'In Review',
    }));
    const text = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [base],
      linkedTickets: many,
    });
    expect(text.split('\n').filter((l) => l.startsWith('- ST3-'))).toHaveLength(10);
    expect(text).toContain('(+4 more blocker(s) not listed)');
  });

  it('truncates an over-long line rather than letting a report blow up the prompt', () => {
    const text = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [base],
      linkedTickets: [{ key: 'ST3-1', status: 'In Review', branch: 'b'.repeat(400) }],
    });
    const line = text.split('\n').find((l) => l.startsWith('- ST3-1'))!;
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('renders byte-identically to feature 020 when there is no blocker data', () => {
    const without = buildWrapperText(ctx, '/tmp/wt', { useCallbackChannel: true, repos: [base] });
    const withEmpty = buildWrapperText(ctx, '/tmp/wt', {
      useCallbackChannel: true,
      repos: [base],
      linkedTickets: [],
    });
    expect(withEmpty).toBe(without);
    expect(without).not.toContain('## Linked tickets');
    expect(without).not.toContain('DEPENDENCY');
  });
});
