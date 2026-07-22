import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Component tests: Vitest (jsdom) + @vue/test-utils + msw. msw fakes `/api/*`
// only — backend code is never imported into the web app (research R1).
export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Match the build: resolve the shared linter from TS source (ESM).
    alias: {
      '@brigadir/contracts/agent-linter': fileURLToPath(
        new URL('../../packages/contracts/src/agent-linter.ts', import.meta.url),
      ),
      '@brigadir/contracts/pagination': fileURLToPath(
        new URL('../../packages/contracts/src/pagination.constants.ts', import.meta.url),
      ),
      '@brigadir/contracts/orchestrator-defaults': fileURLToPath(
        new URL('../../packages/contracts/src/orchestrator-defaults.ts', import.meta.url),
      ),
      '@brigadir/contracts/executor-type-sets': fileURLToPath(
        new URL('../../packages/contracts/src/executor-type-sets.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    globals: false,
  },
});
