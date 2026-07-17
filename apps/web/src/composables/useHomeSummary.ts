import { useQuery } from '@tanstack/vue-query';
import { homeApi } from '../api/home';

const api = homeApi();

/**
 * The atomic Home summary (feature 017, US2+US6): all four tile counters and
 * the spend figures for every period arrive in ONE response, so the tiles row
 * never mixes two moments and the period switcher flips without a refetch.
 * ~5 s polling matches the runs-table cadence.
 */
export function useHomeSummary() {
  return useQuery({
    queryKey: ['home', 'summary'],
    queryFn: () => api.summary(),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });
}
