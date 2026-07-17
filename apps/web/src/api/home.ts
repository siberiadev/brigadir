import type { HomeSummaryResponse, HomeWorkspacesResponse } from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/**
 * Home dashboard REST resource (feature 017, contracts/home-api.md) — the
 * atomic tiles+spend summary and the workspace-cards read model. Read-only.
 */
export function homeApi(client: ApiClient = apiClient) {
  return {
    summary: () => client.get<HomeSummaryResponse>('/api/home/summary'),
    workspaces: () => client.get<HomeWorkspacesResponse>('/api/home/workspaces'),
  };
}
