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
});
