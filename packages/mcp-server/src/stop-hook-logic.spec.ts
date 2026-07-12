import { describe, it, expect } from 'vitest';
import { decideStopHook } from './stop-hook-logic';

describe('decideStopHook (T095)', () => {
  it('marker absent + stop_hook_active=false → block', () => {
    const result = decideStopHook({ markerExists: false, stopHookActive: false });
    expect(result).toMatchObject({ decision: 'block' });
    if ('reason' in result) {
      expect(result.reason).toMatch(/complete_task/);
    }
  });

  it('marker absent + stop_hook_active=true → allow (bound reached, FR-023)', () => {
    const result = decideStopHook({ markerExists: false, stopHookActive: true });
    expect(result).toEqual({ allow: true });
  });

  it('marker present → allow regardless of stop_hook_active', () => {
    expect(decideStopHook({ markerExists: true, stopHookActive: false })).toEqual({ allow: true });
    expect(decideStopHook({ markerExists: true, stopHookActive: true })).toEqual({ allow: true });
  });
});
