import type {
  GlobalRunsResponse,
  RunCancelResponse,
  RunCardResponse,
  RunCostPeriod,
  RunCostResponse,
  RunListResponse,
  RunRetryResponse,
  RunsCancelAllResponse,
} from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** Filters for the workspace-scoped runs table (contracts/runs-api.md, US3). */
export interface RunListParams {
  agent?: string;
  status?: string;
  ticket?: string;
  /** feature 011: trigger-source filter (e.g. 'workspace-setup'). */
  source?: string;
  page?: number;
  page_size?: number;
}

/**
 * Feature 017: the bounded cross-workspace listing (contracts/runs-global-api.md).
 * `status` (CSV) is mandatory by contract; `limit` defaults server-side to 10.
 */
export interface GlobalRunsParams {
  status: string;
  finished_within?: RunCostPeriod;
  limit?: number;
}

/** Runs REST resource (contracts/runs-api.md — table, card, cost, cancel, retry). */
export function runsApi(client: ApiClient = apiClient) {
  return {
    globalList: (params: GlobalRunsParams) =>
      client.get<GlobalRunsResponse>(
        `/api/runs${toQuery({
          status: params.status,
          finished_within: params.finished_within,
          limit: params.limit,
        })}`,
      ),
    list: (workspaceId: string, params: RunListParams = {}) =>
      client.get<RunListResponse>(
        `/api/workspaces/${workspaceId}/runs${toQuery({
          agent: params.agent,
          status: params.status,
          ticket: params.ticket,
          source: params.source,
          page: params.page,
          page_size: params.page_size,
        })}`,
      ),
    cost: (workspaceId: string, period: RunCostPeriod) =>
      client.get<RunCostResponse>(`/api/workspaces/${workspaceId}/runs/cost${toQuery({ period })}`),
    card: (runId: string) => client.get<RunCardResponse>(`/api/runs/${runId}`),
    cancel: (runId: string) => client.post<RunCancelResponse>(`/api/runs/${runId}/cancel`),
    cancelAll: (workspaceId: string) =>
      client.post<RunsCancelAllResponse>(`/api/workspaces/${workspaceId}/runs/cancel-all`),
    retry: (runId: string) => client.post<RunRetryResponse>(`/api/runs/${runId}/retry`),
  };
}
