import { defineWorkspace } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

const paths = () => tsconfigPaths({ projects: ['./tsconfig.base.json'] });

// Emit decorator metadata (design:paramtypes) so NestJS type-based DI resolves
// in tests exactly as it does under the tsc/ts-loader build. Without this,
// vitest's esbuild transform strips the metadata and providers injected by type
// (ModuleRef, services) arrive undefined.
const swcPlugin = () =>
  swc.vite({
    jsc: {
      target: 'es2021',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  });

export default defineWorkspace([
  {
    plugins: [paths(), swcPlugin()],
    test: {
      name: 'unit',
      include: ['libs/**/*.spec.ts', 'apps/**/*.spec.ts'],
      // apps/web is a Vue/jsdom package with its own vitest config (msw +
      // @vue/test-utils) run via `pnpm --filter @brigadir/web test` — keep its
      // component specs out of the node-env unit runner.
      exclude: ['apps/web/**'],
      environment: 'node',
    },
  },
  {
    plugins: [paths(), swcPlugin()],
    test: {
      name: 'integration',
      include: ['test/integration/**/*.spec.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 180_000,
      // One Postgres + one Redis for the whole run; per-suite isolation is
      // logical (own database / own redis db) — see global-setup.ts.
      globalSetup: ['test/integration/global-setup.ts'],
      // Suites stay sequential: they share the two containers' CPU/IO budget,
      // and BullMQ timing assertions are less noisy without a neighbor suite.
      fileParallelism: false,
    },
  },
]);
