import { describe, it, expect } from 'vitest';
import { resolveCostUsd } from './provider-pricing';

describe('resolveCostUsd (DeepSeek provider pricing)', () => {
  it('recomputes deepseek-v4-pro cost from token usage instead of trusting the CLI', () => {
    // Real numbers from the ST3-871 Planner run: the CLI (Anthropic prices)
    // reported $2.3567; DeepSeek prices put the same usage at ~$0.067.
    const cost = resolveCostUsd('deepseek_api', 'deepseek-v4-pro', {
      totalCostUsd: 2.3567,
      usage: {
        input_tokens: 93_093,
        output_tokens: 19_205,
        cache_read_input_tokens: 2_811_392,
        cache_creation_input_tokens: 0,
      },
    });
    // (93093×0.435 + 2811392×0.003625 + 19205×0.87) / 1e6 = 0.067395101
    expect(cost).toBe(0.067395);
  });

  it('bills cache_creation_input_tokens at the cache-miss input rate', () => {
    const cost = resolveCostUsd('deepseek_api', 'deepseek-v4-pro', {
      totalCostUsd: 9.99,
      usage: { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 },
    });
    expect(cost).toBe(0.87); // 2 × $0.435
  });

  it('prices deepseek-v4-flash on its own (cheaper) table row', () => {
    const cost = resolveCostUsd('deepseek_api', 'deepseek-v4-flash', {
      totalCostUsd: 1.0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    expect(cost).toBe(0.42); // 0.14 + 0.28
  });

  it('matches the model case-insensitively and ignores surrounding whitespace', () => {
    const cost = resolveCostUsd('deepseek_api', ' DeepSeek-V4-Pro ', {
      totalCostUsd: 1.0,
      usage: { output_tokens: 1_000_000 },
    });
    expect(cost).toBe(0.87);
  });

  it('passes the CLI cost through for the claude_cli preset (no table entry)', () => {
    const cost = resolveCostUsd('claude_cli', 'claude-sonnet-5', {
      totalCostUsd: 0.0123,
      usage: { input_tokens: 1200, output_tokens: 340 },
    });
    expect(cost).toBe(0.0123);
  });

  it('passes the CLI cost through for a deepseek model missing from the table', () => {
    const cost = resolveCostUsd('deepseek_api', 'deepseek-v5-experimental', {
      totalCostUsd: 0.5,
      usage: { input_tokens: 1000 },
    });
    expect(cost).toBe(0.5);
  });

  it('falls back to the CLI cost when usage is absent or carries no token counts', () => {
    expect(
      resolveCostUsd('deepseek_api', 'deepseek-v4-pro', { totalCostUsd: 0.7, usage: undefined }),
    ).toBe(0.7);
    expect(
      resolveCostUsd('deepseek_api', 'deepseek-v4-pro', {
        totalCostUsd: 0.7,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toBe(0.7);
    expect(
      resolveCostUsd('deepseek_api', 'deepseek-v4-pro', {
        totalCostUsd: 0.7,
        usage: { input_tokens: 'garbage', output_tokens: -5 },
      }),
    ).toBe(0.7);
  });

  it('returns undefined when there is no terminal event at all', () => {
    expect(resolveCostUsd('deepseek_api', 'deepseek-v4-pro', undefined)).toBeUndefined();
  });

  it('computes a cost even when the CLI omitted total_cost_usd', () => {
    const cost = resolveCostUsd('deepseek_api', 'deepseek-v4-pro', {
      usage: { output_tokens: 1_000_000 },
    });
    expect(cost).toBe(0.87);
  });
});
