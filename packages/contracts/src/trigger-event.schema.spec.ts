import { describe, it, expect } from 'vitest';
import { TriggerEventSchema } from './trigger-event.schema';

describe('TriggerEventSchema', () => {
  it('defaults mock_scenario to "success" and source to "manual" when absent', () => {
    const res = TriggerEventSchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.mock_scenario).toBe('success');
      expect(res.data.source).toBe('manual');
    }
  });

  it('accepts every mock scenario', () => {
    for (const s of ['success', 'failure', 'needs_human', 'timeout', 'rate_limited', 'crash']) {
      expect(TriggerEventSchema.safeParse({ mock_scenario: s }).success).toBe(true);
    }
  });

  it('rejects an unknown mock scenario', () => {
    expect(TriggerEventSchema.safeParse({ mock_scenario: 'explode' }).success).toBe(false);
  });
});
