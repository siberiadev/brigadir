import type { PaginationQuery, TicketHistoryResponse, WaitingListResponse } from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** Waiting tickets read surface (feature 022, contracts/dashboard-waiting.md). */
export function ticketsApi(client: ApiClient = apiClient) {
  return {
    waiting: (workspaceId: string, params: Partial<PaginationQuery> = {}) =>
      client.get<WaitingListResponse>(`/api/workspaces/${workspaceId}/waiting${toQuery(params)}`),
    // Ticket history page — addressed by (workspace, jira_key): a ticket UUID
    // is never exposed to the client and the key is unique only per workspace.
    history: (workspaceId: string, key: string) =>
      client.get<TicketHistoryResponse>(
        `/api/workspaces/${workspaceId}/tickets/${encodeURIComponent(key)}/history`,
      ),
  };
}
