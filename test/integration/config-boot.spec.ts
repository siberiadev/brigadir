import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T015 integration-lite + T017 broken matrix: the compiled backend bootstrap
 * (main.api.ts) aborts with a non-zero exit and a path-qualified stderr message
 * for every PRESENT-but-broken config. Config validation runs before any DB
 * access, so these cases need no Postgres.
 *
 * Feature 005 (T128/FR-019): an ABSENT agents.yaml is NO LONGER a boot error —
 * the DB is authoritative and the backend boots on DB-only config. That
 * clean-boot-on-absent-yaml path is covered by config-source-flip.spec.ts (c);
 * only present-but-invalid configs fail fast here.
 */

const ROOT = process.cwd();
const BACKEND_MAIN = join(ROOT, 'dist', 'apps', 'backend', 'main.api.js');
const FIX = (name: string): string => join('test', 'fixtures', name);

function bootWith(configPath: string): { status: number | null; stderr: string } {
  const res = spawnSync('node', [BACKEND_MAIN], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, AGENTS_CONFIG_PATH: configPath, PORT: '0' },
    timeout: 30_000,
  });
  return { status: res.status, stderr: res.stderr ?? '' };
}

describe('backend bootstrap fail-fast on broken config (T015/T017)', () => {
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

  const cases: Array<{ fixture: string; expectPath: RegExp }> = [
    { fixture: 'broken-missing-field.yaml', expectPath: /agents\.0\.status_success/ },
    { fixture: 'broken-wrong-type.yaml', expectPath: /executors\.mock-exec\.concurrency/ },
    { fixture: 'broken-dangling-executor.yaml', expectPath: /agents\.0\.executor/ },
    { fixture: 'broken-unparseable.yaml', expectPath: /not valid YAML/ },
  ];

  for (const { fixture, expectPath } of cases) {
    it(`${fixture} → non-zero exit + stderr names file and field path`, () => {
      const { status, stderr } = bootWith(FIX(fixture));
      expect(status, `expected non-zero exit for ${fixture}`).not.toBe(0);
      expect(stderr).toContain(fixture);
      expect(stderr).toMatch(expectPath);
    });
  }
});
