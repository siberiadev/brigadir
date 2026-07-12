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
});
