import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { ExecutorCreateRequest, ExecutorUpdateRequest } from '@brigadir/contracts';
import { executorsApi } from '../api/executors';

const api = executorsApi();

export function executorsKey(workspaceId: string) {
  return ['executors', workspaceId] as const;
}

/** Workspace executors (US4). Feeds both the admin list and the agent picker. */
export function useExecutors(workspaceId: string) {
  return useQuery({
    queryKey: executorsKey(workspaceId),
    queryFn: () => api.list(workspaceId),
  });
}

export function useCreateExecutor(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExecutorCreateRequest) => api.create(workspaceId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: executorsKey(workspaceId) }),
  });
}

export function useUpdateExecutor(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ExecutorUpdateRequest }) =>
      api.update(workspaceId, id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: executorsKey(workspaceId) }),
  });
}

export function useDeleteExecutor(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.remove(workspaceId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: executorsKey(workspaceId) }),
  });
}
