/**
 * Provider-preset cost indicativeness (features 025/028) — single home for the
 * three inline copies that lived in Runs.vue (`indicativeCostTip(row)`),
 * RunCard.vue (`INDICATIVE_COST_TIP` computed) and now MetricsCost.vue (M6).
 *
 * kimi/deepseek_api runs report a cost priced against Anthropic's list, not the
 * provider's own — so wherever a real cost value shows for those executors it
 * must be flagged as indicative.
 */
export const INDICATIVE_COST_PROVIDERS: Record<string, string> = {
  kimi: 'Moonshot',
  deepseek_api: 'DeepSeek',
};

/** True when this executor type reports indicative (non-billing) cost. */
export function isIndicativeExecutor(executorType: string | null | undefined): boolean {
  return !!executorType && executorType in INDICATIVE_COST_PROVIDERS;
}

/**
 * True when a concrete cost value should carry the indicative caveat: a
 * provider-preset executor AND a non-null cost (a bare "—" needs no caveat).
 */
export function costIsIndicative(
  executorType: string | null | undefined,
  costUsd: string | null | undefined,
): boolean {
  return isIndicativeExecutor(executorType) && costUsd != null;
}

/** The caveat tooltip text for an indicative executor's cost. */
export function indicativeCostTip(executorType: string | null | undefined): string {
  const et = executorType ?? '';
  return `Indicative only — ${et} runs are priced against Anthropic’s list, not ${INDICATIVE_COST_PROVIDERS[et] ?? 'the provider'}’s.`;
}
