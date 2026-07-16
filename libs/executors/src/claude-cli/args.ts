import { join } from 'node:path';
import { z } from 'zod';
import { ReportSchema } from '@brigadir/contracts';

/** The three callback tools' MCP names (contracts/mcp-config.md D3) — appended to --allowed-tools. */
export const CALLBACK_TOOL_NAMES = [
  'mcp__brigadir__report_progress',
  'mcp__brigadir__request_human',
  'mcp__brigadir__complete_task',
] as const;

export interface ArgsInput {
  model: string;
  worktreeDir: string;
  allowedTools: readonly string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Feature 004 (D6): explicit opt-in — additive, default false/omitted keeps iteration-3 shape byte-for-byte. */
  useCallbackChannel?: boolean;
  /** Required when useCallbackChannel: absolute path to the per-run mcp-config file (D1). */
  mcpConfigPath?: string;
  /** Required when useCallbackChannel: the Stop-hook --settings JSON blob (contracts/stop-hook-settings.md). */
  stopHookSettingsJson?: string;
}

// zod 4 native converter (migration 2026-07-16, replaces zod-to-json-schema).
// target stays draft-07: that's what the CLI consumer has always been fed —
// the migration must not change the wire dialect of `--json-schema`.
const REPORT_JSON_SCHEMA = z.toJSONSchema(ReportSchema, { target: 'draft-7' }) as Record<
  string,
  unknown
>;

/**
 * Build the `claude` argv (research D1/D7, contracts/cli-io.md's verified
 * flag table). Pure — no I/O, and the instruction/ticket text is NEVER an
 * argument here: it goes to the child's stdin instead (D7), so this function
 * doesn't even accept it as a parameter.
 *
 * Channel selection is explicit config (`useCallbackChannel`, D6): when
 * omitted/false this is byte-for-byte the iteration-3 shape (`--json-schema`
 * present, no MCP wiring) — the mock executor and feature-003 structured_output
 * runs are untouched. When true, `--json-schema` is DROPPED (FR-011 — exactly
 * one live completion channel), the three `mcp__brigadir__*` tools join
 * `--allowed-tools`, `--mcp-config <path>` is added, and `--settings` carries
 * the Stop-hook registration instead of `{}`.
 */
export function buildArgs(input: ArgsInput): string[] {
  const wrapperPath = join(input.worktreeDir, '.brigadir', 'wrapper.txt');
  const useCallbackChannel = input.useCallbackChannel === true;

  const allowedTools = useCallbackChannel
    ? [...input.allowedTools, ...CALLBACK_TOOL_NAMES]
    : input.allowedTools;

  // Explicit, minimal settings blob: with --strict-mcp-config this neutralizes
  // any host ~/.claude/settings.json from leaking permissions/hooks into the
  // run (Constitution V / D6). Callback-wired runs carry the Stop-hook
  // registration here instead (contracts/stop-hook-settings.md).
  const settings = useCallbackChannel ? (input.stopHookSettingsJson ?? '{}') : JSON.stringify({});

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (!useCallbackChannel) {
    args.push('--json-schema', JSON.stringify(REPORT_JSON_SCHEMA));
  }

  args.push(
    '--model',
    input.model,
    '--append-system-prompt-file',
    wrapperPath,
    '--allowed-tools',
    allowedTools.join(','),
    '--strict-mcp-config',
  );

  if (useCallbackChannel && input.mcpConfigPath) {
    args.push('--mcp-config', input.mcpConfigPath);
  }

  args.push('--settings', settings, '--permission-mode', 'dontAsk');

  if (input.maxTurns !== undefined) {
    args.push('--max-turns', String(input.maxTurns));
  }
  if (input.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(input.maxBudgetUsd));
  }

  return args;
}
