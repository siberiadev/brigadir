import { join } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ReportSchema } from '@brigadir/contracts';

// zod-to-json-schema's types import from the "zod/v3" compat subpath, which
// TS treats as structurally distinct from the plain "zod" import contracts'
// ReportSchema is built with (zod 3.25's v3/v4 split) — same runtime classes,
// incompatible declaration identities, and deep enough to blow TS's
// instantiation-depth limit. The call is boxed through `unknown` so runtime
// behavior (calling the real function with the real schema) is untouched
// while sidestepping that cross-declaration generic inference entirely.
const zodToJsonSchemaUntyped = zodToJsonSchema as unknown as (
  schema: unknown,
  options?: unknown,
) => Record<string, unknown>;

export interface ArgsInput {
  model: string;
  worktreeDir: string;
  allowedTools: readonly string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
}

const REPORT_JSON_SCHEMA = zodToJsonSchemaUntyped(ReportSchema, { target: 'jsonSchema7' });

/**
 * Build the `claude` argv (research D1/D7, contracts/cli-io.md's verified
 * flag table). Pure — no I/O, and the instruction/ticket text is NEVER an
 * argument here: it goes to the child's stdin instead (D7), so this function
 * doesn't even accept it as a parameter.
 *
 * This is the primary and only report-extraction argv shape: D1's residual
 * uncertainty was resolved by a live prototype (CLI v2.1.207, 2026-07-11) —
 * the terminal `result` event carries `structured_output` directly. Do NOT
 * add a `result.result`-text fallback path here.
 */
export function buildArgs(input: ArgsInput): string[] {
  const wrapperPath = join(input.worktreeDir, '.brigadir', 'wrapper.txt');
  // Explicit, minimal settings blob: with --strict-mcp-config this neutralizes
  // any host ~/.claude/settings.json from leaking permissions/hooks into the
  // run (Constitution V / D6). Kept as its own constant so a future hardening
  // addition has one place to land.
  const settings = JSON.stringify({});

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(REPORT_JSON_SCHEMA),
    '--model',
    input.model,
    '--append-system-prompt-file',
    wrapperPath,
    '--allowed-tools',
    input.allowedTools.join(','),
    '--strict-mcp-config',
    '--settings',
    settings,
    '--permission-mode',
    'dontAsk',
  ];

  if (input.maxTurns !== undefined) {
    args.push('--max-turns', String(input.maxTurns));
  }
  if (input.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(input.maxBudgetUsd));
  }

  return args;
}
