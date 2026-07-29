import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ReportSchema } from '@brigadir/contracts';
import { buildArgs, type ArgsInput } from './args';

const input: ArgsInput = {
  model: 'claude-sonnet-5',
  worktreeDir: '/tmp/brigadir/worktrees/run-123',
  allowedTools: ['Read', 'Edit', 'Bash(git *)'],
  maxTurns: 40,
  maxBudgetUsd: 5,
};

const CANARIES = [
  'sk-ant-api-canary',
  'ANTHROPIC_API_KEY',
  'ticket-body-secret-text',
  'JIRA_API_TOKEN',
  'postgres://user:pass@host/db',
];

describe('buildArgs (T077)', () => {
  it('matches a snapshot of the built argv for a representative config', () => {
    expect(buildArgs(input)).toMatchSnapshot();
  });

  it('every element is a string', () => {
    for (const el of buildArgs(input)) {
      expect(typeof el).toBe('string');
    }
  });

  it('contains no ticket text and no environment/secret value', () => {
    const joined = buildArgs(input).join(' ');
    for (const canary of CANARIES) {
      expect(joined).not.toContain(canary);
    }
  });

  it('never accepts or embeds the instruction text (no such parameter exists)', () => {
    // Type-level guarantee: ArgsInput has no `instruction`/`ticket` field —
    // this test documents the intent so a future edit can't quietly add one
    // without a reviewer noticing.
    const keys = Object.keys(input);
    expect(keys).not.toContain('instruction');
    expect(keys).not.toContain('ticket');
  });

  it('--json-schema value JSON.parses to a schema equivalent to z.toJSONSchema(ReportSchema)', () => {
    const args = buildArgs(input);
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[idx + 1]);
    // draft-07 target pinned — the CLI has always been fed this dialect.
    expect(parsed).toEqual(z.toJSONSchema(ReportSchema, { target: 'draft-7' }));
  });

  it('omits --max-turns/--max-budget-usd when not configured', () => {
    const args = buildArgs({ model: 'm', worktreeDir: '/tmp/wt', allowedTools: ['Read'] });
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--max-budget-usd');
  });

  it('--append-system-prompt-file points at <worktree>/.brigadir/wrapper.txt', () => {
    const args = buildArgs(input);
    const idx = args.indexOf('--append-system-prompt-file');
    expect(args[idx + 1]).toBe('/tmp/brigadir/worktrees/run-123/.brigadir/wrapper.txt');
  });

  it('--allowed-tools is a comma-joined list', () => {
    const args = buildArgs(input);
    const idx = args.indexOf('--allowed-tools');
    expect(args[idx + 1]).toBe('Read,Edit,Bash(git *)');
  });
});

describe('buildArgs — useCallbackChannel (T103, D6)', () => {
  it('drops --json-schema, adds ALL six mcp__brigadir__* tools, --mcp-config, and --strict-mcp-config', () => {
    const args = buildArgs({
      ...input,
      useCallbackChannel: true,
      mcpConfigPath: '/tmp/brigadir/mcp-config/run-123.mcp.json',
      stopHookSettingsJson: '{"hooks":{"Stop":[]}}',
    });

    expect(args).not.toContain('--json-schema');
    expect(args).toContain('--strict-mcp-config');

    const toolsIdx = args.indexOf('--allowed-tools');
    const tools = args[toolsIdx + 1].split(',');
    expect(tools).toEqual([
      'Read',
      'Edit',
      'Bash(git *)',
      'mcp__brigadir__report_progress',
      'mcp__brigadir__request_human',
      'mcp__brigadir__complete_task',
      // feature 011 read-only tools — pre-allowed so a live run never stalls
      // on a permission prompt for a read (live-smoke finding, 2026-07-16).
      'mcp__brigadir__get_project_overview',
      'mcp__brigadir__search_tickets',
      'mcp__brigadir__get_ticket',
      // feature 030 read-only role-template tools — same pre-allow rationale.
      'mcp__brigadir__list_role_templates',
      'mcp__brigadir__get_role_template',
    ]);

    const mcpConfigIdx = args.indexOf('--mcp-config');
    expect(mcpConfigIdx).toBeGreaterThanOrEqual(0);
    expect(args[mcpConfigIdx + 1]).toBe('/tmp/brigadir/mcp-config/run-123.mcp.json');

    const settingsIdx = args.indexOf('--settings');
    expect(args[settingsIdx + 1]).toBe('{"hooks":{"Stop":[]}}');
  });

  // Token-spend problem 1: wakeup-polling costs a full cache-read turn per
  // check, same as sleep-polling — waiting must end the session instead.
  it('disallows ScheduleWakeup on the callback channel', () => {
    const args = buildArgs({
      ...input,
      useCallbackChannel: true,
      mcpConfigPath: '/tmp/brigadir/mcp-config/run-123.mcp.json',
      stopHookSettingsJson: '{}',
    });
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('ScheduleWakeup');
  });

  it('the built argv contains no run-token value (grep canary — token never in argv)', () => {
    const runToken = 'super-secret-run-token-value-should-never-appear';
    const args = buildArgs({
      ...input,
      useCallbackChannel: true,
      mcpConfigPath: '/tmp/brigadir/mcp-config/run-123.mcp.json',
      stopHookSettingsJson: '{}',
    });
    expect(args.join(' ')).not.toContain(runToken);
  });

  it('with the flag off, argv is byte-for-byte the iteration-3 shape (--json-schema present)', () => {
    const withFlag = buildArgs({ ...input, useCallbackChannel: false });
    const withoutFlag = buildArgs(input);
    expect(withFlag).toEqual(withoutFlag);
    expect(withFlag).toContain('--json-schema');
    expect(withFlag).not.toContain('--mcp-config');
    expect(withFlag).not.toContain('--disallowed-tools');
  });
});
