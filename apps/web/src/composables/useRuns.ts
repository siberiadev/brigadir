import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { RunCostPeriod } from '@brigadir/contracts';
import { runsApi, type RunListParams } from '../api/runs';

const api = runsApi();

/**
 * The workspace runs table (US3). Reactive filters/pagination live in the
 * query key so a filter change refetches; `refetchInterval` (~5 s) keeps the
 * focused table live (research R1 polling). Previous page kept while fetching
 * to avoid a flash of empty rows on paginate.
 */
export function useRuns(workspaceId: string, params: MaybeRefOrGetter<RunListParams>) {
  return useQuery({
    queryKey: computed(() => ['runs', workspaceId, toValue(params)]),
    queryFn: () => api.list(workspaceId, toValue(params)),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });
}

/** The lite cost figure for the runs header (period preset 24h/7d/30d). */
export function useRunsCost(workspaceId: string, period: MaybeRefOrGetter<RunCostPeriod>) {
  return useQuery({
    queryKey: computed(() => ['runs-cost', workspaceId, toValue(period)]),
    queryFn: () => api.cost(workspaceId, toValue(period)),
    refetchInterval: 5000,
  });
}
