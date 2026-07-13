import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import ElementPlus from 'element-plus';
import type { Component } from 'vue';

// Deliberately loose options typing: this is a shared test harness that mounts
// arbitrary components, so we don't reconstruct each component's exact prop shape.
// `routes`/`initialPath` are optional: when omitted (the ~12 existing specs) the
// harness keeps its single catch-all stub route; when provided (navigation tests)
// it builds a memory router from the app's real routes and seeds `initialPath`.
type MountOptions = {
  props?: Record<string, unknown>;
  global?: { plugins?: unknown[] };
  routes?: RouteRecordRaw[];
  initialPath?: string;
};

/**
 * Mount a component through the app's real providers — a fresh Pinia, a
 * VueQueryPlugin whose QueryClient has retries OFF (tests assert error states
 * immediately), Element Plus, and a memory-history router so RouterLink resolves
 * (quickstart "mount with a TanStack Query + Pinia + Element Plus test harness").
 *
 * Backward compatible: with no `routes` the router is the same single catch-all
 * stub as before. With `routes`, the memory router is built from them and seeded
 * at `initialPath` (default `/`); the caller awaits `wrapper.vm.$router.isReady()`
 * and `flush()` before asserting on the rendered route tree.
 */
export function mountWithProviders(component: Component, options: MountOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const routes: RouteRecordRaw[] = options.routes ?? [
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ];
  const history = createMemoryHistory();
  if (options.routes) {
    // Seed the initial entry BEFORE the router installs, so vue-router's
    // install-time navigation targets `initialPath` (a post-install `push` would
    // race with — and be cancelled by — that install navigation). The test then
    // awaits `wrapper.vm.$router.isReady()` + `flush()` before asserting.
    history.replace(options.initialPath ?? '/');
  }
  const router = createRouter({ history, routes });

  const extraPlugins = options.global?.plugins ?? [];

  return mount(component, {
    props: options.props,
    global: {
      plugins: [
        createPinia(),
        [VueQueryPlugin, { queryClient }],
        router,
        ElementPlus,
        ...extraPlugins,
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/** Let pending microtasks (query/mutation settles, re-renders) flush. */
export async function flush(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
