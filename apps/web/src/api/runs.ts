import type {
  RunCancelResponse,
  RunCardResponse,
  RunCostPeriod,
  RunCostResponse,
  RunListResponse,
  RunRetryResponse,
} from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/** Filters for the workspace-scoped runs table (contracts/runs-api.md, US3). */
export interface RunListParams {
  agent?: string;
  status?: string;
  ticket?: string;
  page?: number;
  page_size?: number;
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Runs REST resource (contracts/runs-api.md — table, card, cost, cancel, retry). */
export function runsApi(client: ApiClient = apiClient) {
  return {
    list: (workspaceId: string, params: RunListParams = {}) =>
      client.get<RunListResponse>(
        `/api/workspaces/${workspaceId}/runs${toQuery({
          agent: params.agent,
          status: params.status,
          ticket: params.ticket,
          page: params.page,
          page_size: params.page_size,
        })}`,
      ),
    cost: (workspaceId: string, period: RunCostPeriod) =>
      client.get<RunCostResponse>(`/api/workspaces/${workspaceId}/runs/cost${toQuery({ period })}`),
    card: (runId: string) => client.get<RunCardResponse>(`/api/runs/${runId}`),
    cancel: (runId: string) => client.post<RunCancelResponse>(`/api/runs/${runId}/cancel`),
    retry: (runId: string) => client.post<RunRetryResponse>(`/api/runs/${runId}/retry`),
  };
}
