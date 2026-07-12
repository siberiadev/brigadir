import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

// msw lifecycle for every component test. `onUnhandledRequest: 'error'` keeps the
// suite honest — a call to an unfaked `/api/*` route fails loudly rather than
// silently hitting the network (mirrors the backend's testcontainers discipline).
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
