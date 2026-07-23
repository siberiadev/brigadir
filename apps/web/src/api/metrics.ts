import type {
  MetricsActivityResponse,
  MetricsCostResponse,
  MetricsHumanResponse,
  MetricsOverviewResponse,
  MetricsReliabilityResponse,
  RunCostPeriod,
} from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/**
 * Metrics timeline REST resource (feature 029, contracts/metrics-api.md) — the
 * five read-only aggregate endpoints. Read-only; every method takes the shared
 * filter set (period + optional workspace/executor). Response methods are added
 * per user story.
 */

/** The shared filter shape the page threads to every panel. */
export interface MetricsFilterParams {
  period: RunCostPeriod;
  workspace_id?: string;
  executor_type?: string;
}

/** Filters → query string, skipping empty optionals (shared client helper). */
export function metricsQuery(params: MetricsFilterParams): string {
  return toQuery({
    period: params.period,
    workspace_id: params.workspace_id,
    executor_type: params.executor_type,
  });
}

export function metricsApi(client: ApiClient = apiClient) {
  return {
    overview: (params: MetricsFilterParams) =>
      client.get<MetricsOverviewResponse>(`/api/metrics/overview${metricsQuery(params)}`),
    cost: (params: MetricsFilterParams) =>
      client.get<MetricsCostResponse>(`/api/metrics/cost${metricsQuery(params)}`),
    reliability: (params: MetricsFilterParams) =>
      client.get<MetricsReliabilityResponse>(`/api/metrics/reliability${metricsQuery(params)}`),
    activity: (params: MetricsFilterParams) =>
      client.get<MetricsActivityResponse>(`/api/metrics/activity${metricsQuery(params)}`),
    // executor_type is ignored server-side on this endpoint (H1/FR-011a); the
    // page also disables the executor picker on the Human tab.
    human: (params: MetricsFilterParams) =>
      client.get<MetricsHumanResponse>(`/api/metrics/human${metricsQuery(params)}`),
  };
}
