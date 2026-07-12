import type { StatusesResponse } from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/** Board statuses resource (contracts/dashboard-api.md — GET /workspaces/:id/statuses). */
export function statusesApi(client: ApiClient = apiClient) {
  return {
    // `refresh` forces a live Jira re-fetch (the agent form issues this on open, FR-011).
    get: (workspaceId: string, opts: { refresh?: boolean } = {}) =>
      client.get<StatusesResponse>(
        `/api/workspaces/${workspaceId}/statuses${opts.refresh ? '?refresh=true' : ''}`,
      ),
  };
}
