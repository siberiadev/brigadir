import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

// jsdom has no ResizeObserver; Vue Flow (feature 018) requires one at module
// scope even when the canvas is stubbed in tests. No-op is enough — layout
// measurements are never asserted (research R3).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// msw lifecycle for every component test. `onUnhandledRequest: 'error'` keeps the
// suite honest — a call to an unfaked `/api/*` route fails loudly rather than
// silently hitting the network (mirrors the backend's testcontainers discipline).
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
