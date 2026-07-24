import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Plain Vite + Vue 3 SPA (feature 005, research R1). NOT a Nest build target —
// kept out of nest-cli.json and off `nest build`. `vite build` emits ./dist,
// served statically by the backend (ServeStaticModule) in production.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // '@' -> ./src, so SFCs can `@use '@/styles/variables' as *;` and TS/Vue
      // imports can use '@/...' without long relative paths.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The only RUNTIME value the web app pulls from contracts is the shared
      // linter. Import it from its TS SOURCE module (ESM, deps: types only) so
      // rollup can trace it and we avoid the CJS barrel — whose `export *` would
      // otherwise drag node:crypto (run-token) into the browser bundle. All
      // other contracts imports are type-only and erased at build.
      '@brigadir/contracts/agent-linter': fileURLToPath(
        new URL('../../packages/contracts/src/agent-linter.ts', import.meta.url),
      ),
      // Same pattern for the pagination constants (dep-free TS source module).
      '@brigadir/contracts/pagination': fileURLToPath(
        new URL('../../packages/contracts/src/pagination.constants.ts', import.meta.url),
      ),
      // Same pattern for the built-in brigadir instruction defaults (dep-free
      // string constants) — the Settings "Reset to default" buttons need them
      // at runtime.
      '@brigadir/contracts/orchestrator-defaults': fileURLToPath(
        new URL('../../packages/contracts/src/orchestrator-defaults.ts', import.meta.url),
      ),
      // Same pattern for the executor type-set constants/guards (feature 028,
      // dep-free TS source module) — the ExecutorForm needs them at runtime.
      '@brigadir/contracts/executor-type-sets': fileURLToPath(
        new URL('../../packages/contracts/src/executor-type-sets.ts', import.meta.url),
      ),
      // Same pattern for the env-variable rules (feature 031, dep-free TS source
      // module) — the EnvVarsTable form validates keys/caps at runtime.
      '@brigadir/contracts/env': fileURLToPath(
        new URL('../../packages/contracts/src/env.constants.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // Dev-only convenience: the browser always calls same-origin `/api/*`; the
    // proxy forwards to the backend so no CORS and no baked-in backend host.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
  },
  css: {
    preprocessorOptions: {
      // Use Dart Sass's modern API — silences the legacy-js-api deprecation
      // warning and is the path forward before Dart Sass 2.0 drops the old one.
      scss: { api: 'modern' },
    },
  },
});
