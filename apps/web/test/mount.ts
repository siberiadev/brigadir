import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query';
import { createRouter, createMemoryHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import type { Component } from 'vue';

// Deliberately loose options typing: this is a shared test harness that mounts
// arbitrary components, so we don't reconstruct each component's exact prop shape.
type MountOptions = { props?: Record<string, unknown>; global?: { plugins?: unknown[] } };

/**
 * Mount a component through the app's real providers — a fresh Pinia, a
 * VueQueryPlugin whose QueryClient has retries OFF (tests assert error states
 * immediately), Element Plus, and a memory-history router so RouterLink resolves
 * (quickstart "mount with a TanStack Query + Pinia + Element Plus test harness").
 */
export function mountWithProviders(component: Component, options: MountOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });

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
