import { describe, it, expect } from 'vitest';
import { pluralize } from '../src/utils/pluralize';

describe('pluralize', () => {
  it('singular for exactly one', () => {
    expect(pluralize(1, 'step')).toBe('1 step');
  });

  it('plural for zero and many', () => {
    expect(pluralize(0, 'step')).toBe('0 steps');
    expect(pluralize(100, 'step')).toBe('100 steps');
  });

  it('accepts an explicit irregular plural', () => {
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
  });
});
