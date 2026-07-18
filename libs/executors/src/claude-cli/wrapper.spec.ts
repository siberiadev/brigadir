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
      { name: 'lib', absPath: '/wt/run-1/lib', defaultBranch: 'main', branch: 'feat/BRIG-1' },
      { name: 'consumer', absPath: '/wt/run-1/consumer', defaultBranch: 'develop', branch: 'feat/BRIG-1' },
    ];

    it('lists every prepared repo with absolute path, branch and base branch', () => {
      const text = buildWrapperText(ctx, '/wt/run-1', { useCallbackChannel: true, repos });
      expect(text).toContain('## Repositories');
      expect(text).toContain('- lib: /wt/run-1/lib (branch feat/BRIG-1, based on main)');
      expect(text).toContain('- consumer: /wt/run-1/consumer (branch feat/BRIG-1, based on develop)');
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
