import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMcpConfig, defaultMcpConfigRoot } from './mcp-config';

describe('writeMcpConfig (T103, D1/D8)', () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('writes a 0600 file with the literal token in the server env block — never ${VAR}', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    const written = await writeMcpConfig(
      {
        runId: 'run-123',
        callbackUrl: 'http://localhost:3000/api/callbacks',
        runToken: 'literal-run-token-value',
        mcpServerEntryPath: '/abs/path/packages/mcp-server/dist/main.js',
      },
      root,
    );

    const stats = await stat(written.configPath);
    expect(stats.mode & 0o777).toBe(0o600);

    const raw = await readFile(written.configPath, 'utf8');
    expect(raw).not.toContain('${');
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.brigadir.env.BRIGADIR_RUN_TOKEN).toBe('literal-run-token-value');
    expect(parsed.mcpServers.brigadir.env.BRIGADIR_RUN_ID).toBe('run-123');
    expect(parsed.mcpServers.brigadir.env.BRIGADIR_CALLBACK_URL).toBe('http://localhost:3000/api/callbacks');
    expect(parsed.mcpServers.brigadir.args).toEqual(['/abs/path/packages/mcp-server/dist/main.js']);
  });

  it('sits outside the worktree — the config root is caller-controlled, independent of any worktree path', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    const worktreeDir = join(root, 'worktrees', 'run-123');
    const configRoot = join(root, 'mcp-config'); // sibling, NOT nested under worktreeDir

    const written = await writeMcpConfig(
      { runId: 'run-123', callbackUrl: 'http://x', runToken: 't', mcpServerEntryPath: '/x/main.js' },
      configRoot,
    );

    expect(written.configPath.startsWith(worktreeDir)).toBe(false);
    expect(written.configPath.startsWith(configRoot)).toBe(true);
  });

  it('builds a Stop-hook settings blob with the marker path baked into the command', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    const written = await writeMcpConfig(
      { runId: 'run-123', callbackUrl: 'http://x', runToken: 't', mcpServerEntryPath: '/x/main.js' },
      root,
    );

    const settings = JSON.parse(written.settingsJson);
    const command = settings.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain('stop-hook.js');
    expect(command).toContain(written.markerPath);
  });

  // Token-spend problem 1: the bash-guard hook rides the same settings blob.
  it('registers the PreToolUse bash-guard on Bash, pointing at the sibling of main.js', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    const written = await writeMcpConfig(
      { runId: 'run-123', callbackUrl: 'http://x', runToken: 't', mcpServerEntryPath: '/x/main.js' },
      root,
    );

    const settings = JSON.parse(written.settingsJson);
    const entry = settings.hooks.PreToolUse[0];
    expect(entry.matcher).toBe('Bash');
    const command = entry.hooks[0].command as string;
    expect(command).toBe('node /x/bash-guard.js');
  });

  it('cleanup removes the config file and the marker (if present)', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    const written = await writeMcpConfig(
      { runId: 'run-123', callbackUrl: 'http://x', runToken: 't', mcpServerEntryPath: '/x/main.js' },
      root,
    );
    await writeFile(written.markerPath, 'marker');

    await written.cleanup();

    await expect(stat(written.configPath)).rejects.toThrow();
    await expect(stat(written.markerPath)).rejects.toThrow();
  });

  // Feature 024 (US3): BRIGADIR_REPO_DIRS carries the run's worktree dirs so
  // the tool server can observe each repo's HEAD at complete_task.
  it('writes BRIGADIR_REPO_DIRS as a JSON repo→dir map for repo runs', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    const repoDirs = { product: '/wt/run-1/product', infra: '/wt/run-1/infra' };
    const written = await writeMcpConfig(
      { runId: 'run-1', callbackUrl: 'http://x', runToken: 't', mcpServerEntryPath: '/x/main.js', repoDirs },
      root,
    );
    const env = JSON.parse(await readFile(written.configPath, 'utf8')).mcpServers.brigadir.env;
    expect(JSON.parse(env.BRIGADIR_REPO_DIRS)).toEqual(repoDirs);
  });

  it('omits BRIGADIR_REPO_DIRS entirely for no-repo runs (absent or empty map)', async () => {
    root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-config-test-'));
    for (const repoDirs of [undefined, {}]) {
      const written = await writeMcpConfig(
        { runId: 'run-1', callbackUrl: 'http://x', runToken: 't', mcpServerEntryPath: '/x/main.js', repoDirs },
        root,
      );
      const env = JSON.parse(await readFile(written.configPath, 'utf8')).mcpServers.brigadir.env;
      expect(env).not.toHaveProperty('BRIGADIR_REPO_DIRS');
    }
  });

  it('defaultMcpConfigRoot nests under brigadir/mcp-config of the given base', () => {
    expect(defaultMcpConfigRoot('/tmp')).toBe(join('/tmp', 'brigadir', 'mcp-config'));
  });
});
