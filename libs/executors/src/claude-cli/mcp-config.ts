import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-run mcp-config file + Stop-hook settings (contracts/mcp-config.md,
 * contracts/stop-hook-settings.md, research D1/D2/D8). Written OUTSIDE the
 * worktree, mode 0600, with the run token as a LITERAL value in the server
 * `env` block — never `${VAR}` interpolation (D1: the Bash tool inherits
 * `claude`'s own process env, so expansion would leak the token there).
 */

export interface McpConfigInput {
  runId: string;
  callbackUrl: string;
  runToken: string;
  /** Absolute path to the built `packages/mcp-server/dist/main.js`. */
  mcpServerEntryPath: string;
  /**
   * Feature 024: map of repo name → absolute worktree dir for this run. The
   * tool server reads it (`BRIGADIR_REPO_DIRS`) to observe each repo's HEAD at
   * `complete_task` time (the completion gate). Absent/empty for no-repo runs
   * ⇒ the env var is not written and the gate stays silent.
   */
  repoDirs?: Record<string, string>;
}

export interface WrittenMcpConfig {
  /** Absolute path to the written mcp-config JSON file (mode 0600). */
  configPath: string;
  /** Absolute path to the completion marker (not created here — brigadir-mcp writes it). */
  markerPath: string;
  /** The Stop-hook `--settings` JSON blob (contracts/stop-hook-settings.md). */
  settingsJson: string;
  /** Deletes the config file and the marker (if present). Idempotent. */
  cleanup: () => Promise<void>;
}

/** Directory OUTSIDE any worktree that holds ephemeral per-run mcp-config + marker files. */
export function defaultMcpConfigRoot(baseTmpDir: string): string {
  return join(baseTmpDir, 'brigadir', 'mcp-config');
}

export async function writeMcpConfig(input: McpConfigInput, configRoot: string): Promise<WrittenMcpConfig> {
  await mkdir(configRoot, { recursive: true });

  const configPath = join(configRoot, `${input.runId}.mcp.json`);
  const markerPath = join(configRoot, `${input.runId}.marker`);
  const stopHookEntryPath = input.mcpServerEntryPath.replace(/main\.js$/, 'stop-hook.js');

  const hasRepoDirs = input.repoDirs !== undefined && Object.keys(input.repoDirs).length > 0;
  const mcpConfig = {
    mcpServers: {
      brigadir: {
        command: 'node',
        args: [input.mcpServerEntryPath],
        env: {
          BRIGADIR_RUN_ID: input.runId,
          BRIGADIR_CALLBACK_URL: input.callbackUrl,
          // LITERAL value — never `${BRIGADIR_RUN_TOKEN}` (Constitution V, D1).
          BRIGADIR_RUN_TOKEN: input.runToken,
          BRIGADIR_MARKER_PATH: markerPath,
          // Feature 024: worktree dirs for the completion gate's HEAD probe.
          // Omitted entirely for no-repo runs so the gate stays silent there.
          ...(hasRepoDirs ? { BRIGADIR_REPO_DIRS: JSON.stringify(input.repoDirs) } : {}),
        },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(mcpConfig), { mode: 0o600 });
  // Belt-and-suspenders: writeFile's `mode` is masked by umask on some
  // platforms — chmod afterward guarantees 0600 regardless.
  await chmod(configPath, 0o600);

  const settingsJson = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [{ type: 'command', command: `node ${stopHookEntryPath} ${markerPath}` }],
        },
      ],
    },
  });

  return {
    configPath,
    markerPath,
    settingsJson,
    cleanup: async () => {
      await rm(configPath, { force: true });
      await rm(markerPath, { force: true });
    },
  };
}
