import type { PaginationQuery, WaitingListResponse } from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** Waiting tickets read surface (feature 022, contracts/dashboard-waiting.md). */
export function ticketsApi(client: ApiClient = apiClient) {
  return {
    waiting: (workspaceId: string, params: Partial<PaginationQuery> = {}) =>
      client.get<WaitingListResponse>(`/api/workspaces/${workspaceId}/waiting${toQuery(params)}`),
  };
}
