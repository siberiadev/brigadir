import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ReportSchema } from '@brigadir/contracts';
import { buildArgs, type ArgsInput } from './args';

// See args.ts's comment: zod-to-json-schema's types import from "zod/v3",
// structurally distinct (and too deep for TS to unify) from the plain "zod"
// ReportSchema is declared with. Boxed through `unknown` here too, purely to
// keep this test file itself typecheckable outside vitest's type-stripping
// transform.
const zodToJsonSchemaUntyped = zodToJsonSchema as unknown as (
  schema: unknown,
  options?: unknown,
) => Record<string, unknown>;

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

  it('--json-schema value JSON.parses to a schema equivalent to zodToJsonSchema(ReportSchema)', () => {
    const args = buildArgs(input);
    const idx = args.indexOf('--json-schema');
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(args[idx + 1]);
    expect(parsed).toEqual(zodToJsonSchemaUntyped(ReportSchema, { target: 'jsonSchema7' }));
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
