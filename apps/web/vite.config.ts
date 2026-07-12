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
      // The only RUNTIME value the web app pulls from contracts is the shared
      // linter. Import it from its TS SOURCE module (ESM, deps: types only) so
      // rollup can trace it and we avoid the CJS barrel — whose `export *` would
      // otherwise drag node:crypto (run-token) into the browser bundle. All
      // other contracts imports are type-only and erased at build.
      '@brigadir/contracts/agent-linter': fileURLToPath(
        new URL('../../packages/contracts/src/agent-linter.ts', import.meta.url),
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
});
