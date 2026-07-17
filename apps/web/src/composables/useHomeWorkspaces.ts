import { useQuery } from '@tanstack/vue-query';
import { homeApi } from '../api/home';

const api = homeApi();

/**
 * The workspace-cards read model (feature 017, US5): every workspace with its
 * dashboard aggregates in ONE request — no per-card fan-out (FR-020). The grid
 * changes slowly, so it polls at a relaxed 15 s.
 */
export function useHomeWorkspaces() {
  return useQuery({
    queryKey: ['home', 'workspaces'],
    queryFn: () => api.workspaces(),
    refetchInterval: 15000,
    placeholderData: (prev) => prev,
  });
}
