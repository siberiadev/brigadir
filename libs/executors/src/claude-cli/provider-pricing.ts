import type { ExecutorType } from '../agent-executor.interface';

/**
 * Provider-side token pricing (USD per 1M tokens) for executor presets whose
 * endpoint is NOT Anthropic. The Claude CLI computes `total_cost_usd` from
 * ANTHROPIC model prices no matter what ANTHROPIC_BASE_URL points at, so for
 * the DeepSeek preset the CLI's number is ~30× the real bill (observed on
 * ST3-871: CLI reported $8.55 across 4 runs, the DeepSeek admin panel billed
 * ~$0.28). Where a table entry exists, the run's cost is recomputed from the
 * terminal event's token usage; everywhere else the CLI's number passes
 * through unchanged.
 *
 * Prices: https://api-docs.deepseek.com/quick_start/pricing/ (2026-07-22).
 * Cache WRITES have no surcharge on DeepSeek — `cache_creation_input_tokens`
 * bill at the ordinary cache-miss input rate.
 */
export interface ModelPricingUsdPerMTok {
  /** `input_tokens` + `cache_creation_input_tokens` (cache miss / write). */
  inputCacheMiss: number;
  /** `cache_read_input_tokens` (cache hit). */
  inputCacheHit: number;
  /** `output_tokens`. */
  output: number;
}

const DEEPSEEK_MODEL_PRICING: Record<string, ModelPricingUsdPerMTok> = {
  'deepseek-v4-pro': { inputCacheMiss: 0.435, inputCacheHit: 0.003625, output: 0.87 },
  'deepseek-v4-flash': { inputCacheMiss: 0.14, inputCacheHit: 0.0028, output: 0.28 },
};

const PROVIDER_MODEL_PRICING: Partial<Record<ExecutorType, Record<string, ModelPricingUsdPerMTok>>> =
  {
    deepseek_api: DEEPSEEK_MODEL_PRICING,
  };

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The run's effective cost in USD: recomputed from token usage when a price
 * table exists for (executor type, model), else the CLI's own
 * `total_cost_usd`. Falls back to the CLI number whenever usage is absent or
 * carries no token counts — a wrong-currency number beats a silent undefined
 * for budget accounting, and non-priced presets keep byte-identical behavior.
 */
export function resolveCostUsd(
  executorType: ExecutorType,
  model: string,
  terminal: { totalCostUsd?: number; usage?: unknown } | undefined,
): number | undefined {
  if (!terminal) return undefined;
  const pricing = PROVIDER_MODEL_PRICING[executorType]?.[model.trim().toLowerCase()];
  if (!pricing || typeof terminal.usage !== 'object' || terminal.usage === null) {
    return terminal.totalCostUsd;
  }
  const u = terminal.usage as Record<string, unknown>;
  const miss = tokens(u.input_tokens) + tokens(u.cache_creation_input_tokens);
  const hit = tokens(u.cache_read_input_tokens);
  const out = tokens(u.output_tokens);
  if (miss + hit + out === 0) return terminal.totalCostUsd;
  const cost =
    (miss * pricing.inputCacheMiss + hit * pricing.inputCacheHit + out * pricing.output) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}
