import { describe, it, expect } from 'vitest';
import { formatTokens } from '../src/utils/number';

describe('formatTokens', () => {
  it('keeps values under 1000 exact', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(340)).toBe('340');
    expect(formatTokens(999)).toBe('999');
  });

  it('compacts thousands to k with one decimal, dropping a trailing .0', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(999949)).toBe('999.9k');
  });

  it('compacts millions to M', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });

  it('returns null for null/undefined/garbage', () => {
    expect(formatTokens(null)).toBeNull();
    expect(formatTokens(undefined)).toBeNull();
    expect(formatTokens(Number.NaN)).toBeNull();
  });
});
