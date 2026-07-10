import { defineWorkspace } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const paths = () => tsconfigPaths({ projects: ['./tsconfig.base.json'] });

export default defineWorkspace([
  {
    plugins: [paths()],
    test: {
      name: 'unit',
      include: ['libs/**/*.spec.ts', 'apps/**/*.spec.ts'],
      environment: 'node',
    },
  },
  {
    plugins: [paths()],
    test: {
      name: 'integration',
      include: ['test/integration/**/*.spec.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 180_000,
      // Real broker/DB semantics are the point — do not run integration
      // suites in parallel against shared containers.
      fileParallelism: false,
    },
  },
]);
