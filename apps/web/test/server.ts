import { setupServer } from 'msw/node';
import { defaultHandlers } from './handlers';

/** The shared msw server — started in test/setup.ts, overridden per test. */
export const server = setupServer(...defaultHandlers);
