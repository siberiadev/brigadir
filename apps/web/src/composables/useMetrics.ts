import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { metricsApi, type MetricsFilterParams } from '../api/metrics';

const api = metricsApi();

/**
 * Metrics timeline queries (feature 029). Each key carries the full filter set
 * so a filter change refetches; `placeholderData: (prev) => prev` keeps the
 * previous chart on screen while the next loads (no flash of empty). Panels
 * mount lazily (el-tab-pane `lazy`), so a tab's query fires only once opened.
 */

/** Overview scalars (US1). */
export function useMetricsOverview(filters: MaybeRefOrGetter<MetricsFilterParams>) {
  return useQuery({
    queryKey: computed(() => ['metrics-overview', toValue(filters)]),
    queryFn: () => api.overview(toValue(filters)),
    placeholderData: (prev) => prev,
  });
}

/** Cost & usage timelines (US2). */
export function useMetricsCost(filters: MaybeRefOrGetter<MetricsFilterParams>) {
  return useQuery({
    queryKey: computed(() => ['metrics-cost', toValue(filters)]),
    queryFn: () => api.cost(toValue(filters)),
    placeholderData: (prev) => prev,
  });
}

/** Run reliability timelines (US3). */
export function useMetricsReliability(filters: MaybeRefOrGetter<MetricsFilterParams>) {
  return useQuery({
    queryKey: computed(() => ['metrics-reliability', toValue(filters)]),
    queryFn: () => api.reliability(toValue(filters)),
    placeholderData: (prev) => prev,
  });
}

/** Activity & triggers timelines (US4). */
export function useMetricsActivity(filters: MaybeRefOrGetter<MetricsFilterParams>) {
  return useQuery({
    queryKey: computed(() => ['metrics-activity', toValue(filters)]),
    queryFn: () => api.activity(toValue(filters)),
    placeholderData: (prev) => prev,
  });
}

/** Human-in-the-loop timelines (US5). executor_type is ignored (H1/FR-011a). */
export function useMetricsHuman(filters: MaybeRefOrGetter<MetricsFilterParams>) {
  return useQuery({
    queryKey: computed(() => ['metrics-human', toValue(filters)]),
    queryFn: () => api.human(toValue(filters)),
    placeholderData: (prev) => prev,
  });
}
