import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { CallbackHealthController } from './callback-health.controller';

/**
 * Feature 026 (US4) — the unauthenticated liveness endpoint. Static body, no
 * guard, no dependencies (contracts/callback-health.md).
 */
describe('CallbackHealthController (feature 026, US4)', () => {
  it('returns a static { status: "ok" } body', () => {
    const controller = new CallbackHealthController();
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('has no dependencies (constructable with no args → no DB / secrets)', () => {
    expect(CallbackHealthController.length).toBe(0);
  });

  it('carries no guard metadata (unguarded surface, FR-016)', () => {
    // Nest stores @UseGuards under the '__guards__' metadata key. Its absence
    // proves the RunTokenGuard is not applied to this controller or its route.
    const classGuards = Reflect.getMetadata('__guards__', CallbackHealthController);
    const methodGuards = Reflect.getMetadata('__guards__', CallbackHealthController.prototype.health);
    expect(classGuards).toBeUndefined();
    expect(methodGuards).toBeUndefined();
  });
});
