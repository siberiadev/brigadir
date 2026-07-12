import { useQuery } from '@tanstack/vue-query';
import { statusesApi } from '../api/statuses';

const api = statusesApi();

export function statusesKey(workspaceId: string) {
  return ['workspace', workspaceId, 'statuses'] as const;
}

/**
 * Board statuses for the agent form. `refresh` forces a live re-fetch (the form
 * issues this on open, FR-011). Retries are off so a 502 statuses_unavailable
 * surfaces immediately and the form can block status editing.
 */
export function useStatuses(workspaceId: string, opts: { refresh?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: statusesKey(workspaceId),
    queryFn: () => api.get(workspaceId, { refresh: opts.refresh }),
    enabled: opts.enabled ?? true,
    retry: false,
  });
}
