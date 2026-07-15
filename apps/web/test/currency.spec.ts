import { describe, it, expect } from 'vitest';
import { formatCost, formatCostUsd } from '../src/utils/currency';

describe('formatCost / formatCostUsd', () => {
  it('rounds numeric(10,4) strings to 2 decimals', () => {
    expect(formatCost('2.3911')).toBe('2.39');
    expect(formatCost('2.3951')).toBe('2.40'); // rounds, not truncates
    expect(formatCost('0.5')).toBe('0.50'); // pads to 2 decimals
    expect(formatCostUsd('1.2345')).toBe('$1.23');
  });

  it('returns null for null/undefined/empty/garbage', () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost('')).toBeNull();
    expect(formatCost('not-a-number')).toBeNull();
    expect(formatCostUsd(null)).toBeNull();
  });
});
