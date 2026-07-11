import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutorRegistry } from '@brigadir/executors';
import { WorkerAppModule } from '../../apps/worker/src/app.module';
import { RunProcessor } from '../../apps/worker/src/run.processor';
import { ClaudeCliRunProcessor } from '../../apps/worker/src/claude-cli-run.processor';
import { startDatabase, startRedis, DbHarness, RedisHarness } from './harness';
import { setupClaudeCliTestEnv, resetFakeClaudeEnv, type ClaudeCliTestEnv } from './claude-cli-harness';

/**
 * T089 (US6, SC-002 config half): `claude_cli` and `mock` coexist in one
 * `agents.yaml` — both validate at boot, both resolve by type — and an
 * invalid `claude_cli` block aborts boot with a path-qualified error,
 * exactly like every other config mistake already covered by
 * config-boot.spec.ts (T015/T017).
 */
describe('claude_cli config coexistence (T089/US6)', () => {
  describe('boots with both mock and claude_cli declared', () => {
    let db: DbHarness;
    let redis: RedisHarness;
    let worker: TestingModule;
    let env: ClaudeCliTestEnv;

    beforeAll(async () => {
      env = await setupClaudeCliTestEnv(); // yaml declares mock-exec (type mock) + coder (type claude_cli)
      db = await startDatabase();
      redis = await startRedis();
      process.env.DATABASE_URL = db.url;
      process.env.REDIS_URL = redis.url;
      process.env.AGENTS_CONFIG_PATH = env.agentsConfigPath;

      worker = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
      await worker.init();
      await worker.get(RunProcessor).worker.waitUntilReady();
      await worker.get(ClaudeCliRunProcessor).worker.waitUntilReady();
    }, 240_000);

    afterAll(async () => {
      await worker?.close();
      await db?.stop();
      await redis?.stop();
      resetFakeClaudeEnv();
      await env?.cleanup();
    });

    it('both executor types validate at boot and resolve via ExecutorRegistry', () => {
      const registry = worker.get(ExecutorRegistry);
      expect(registry.has('mock')).toBe(true);
      expect(registry.has('claude_cli')).toBe(true);
      expect(registry.resolve('mock').type).toBe('mock');
      expect(registry.resolve('claude_cli').type).toBe('claude_cli');
    });
  });

  describe('invalid claude_cli config aborts boot with a path-qualified error', () => {
    const ROOT = process.cwd();
    const BACKEND_MAIN = join(ROOT, 'dist', 'apps', 'backend', 'main.api.js');
    const FIX = (name: string): string => join('test', 'fixtures', name);

    beforeAll(() => {
      if (!existsSync(BACKEND_MAIN)) {
        const build = spawnSync('pnpm', ['exec', 'nest', 'build', 'backend'], {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 180_000,
        });
        if (build.status !== 0) {
          throw new Error(`nest build backend failed:\n${build.stdout}\n${build.stderr}`);
        }
      }
    }, 180_000);

    function bootWith(configPath: string): { status: number | null; stderr: string } {
      const res = spawnSync('node', [BACKEND_MAIN], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, AGENTS_CONFIG_PATH: configPath, PORT: '0' },
        timeout: 30_000,
      });
      return { status: res.status, stderr: res.stderr ?? '' };
    }

    it('repository not in workspace.repositories[].name → non-zero exit naming executors.coder.repository', () => {
      const { status, stderr } = bootWith(FIX('broken-claude-cli-unknown-repo.yaml'));
      expect(status).not.toBe(0);
      expect(stderr).toContain('broken-claude-cli-unknown-repo.yaml');
      expect(stderr).toMatch(/executors\.coder\.repository/);
      expect(stderr).toContain('does-not-exist');
    });

    it('missing model → non-zero exit naming executors.coder.model', () => {
      const { status, stderr } = bootWith(FIX('broken-claude-cli-missing-model.yaml'));
      expect(status).not.toBe(0);
      expect(stderr).toContain('broken-claude-cli-missing-model.yaml');
      expect(stderr).toMatch(/executors\.coder\.model/);
    });
  });
});
