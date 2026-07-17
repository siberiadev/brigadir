import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { runsApi, type GlobalRunsParams } from '../api/runs';

const api = runsApi();

/**
 * The bounded cross-workspace runs list (feature 017, US3+US4). The mandatory
 * `status` filter lives in the key, so needs-attention and live-runs consumers
 * keep separate caches. ~5 s polling; previous rows kept while refetching so
 * the lists never flash empty.
 */
export function useGlobalRuns(params: MaybeRefOrGetter<GlobalRunsParams>) {
  return useQuery({
    queryKey: computed(() => ['runs', 'global', toValue(params)]),
    queryFn: () => api.globalList(toValue(params)),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });
}
