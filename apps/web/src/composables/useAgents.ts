import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { AgentWriteRequest, PaginationQuery } from '@brigadir/contracts';
import { agentsApi } from '../api/agents';

const api = agentsApi();

export function agentsKey(workspaceId: string) {
  return ['agents', workspaceId] as const;
}

export function useAgents(
  workspaceId: string,
  params: MaybeRefOrGetter<Partial<PaginationQuery>> = {},
) {
  return useQuery({
    queryKey: computed(() => [...agentsKey(workspaceId), toValue(params)]),
    queryFn: () => api.list(workspaceId, toValue(params)),
    placeholderData: (prev) => prev,
  });
}

export function useCreateAgent(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentWriteRequest) => api.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentsKey(workspaceId) }),
  });
}

export function useUpdateAgent(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AgentWriteRequest }) => api.update(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentsKey(workspaceId) }),
  });
}

export function useDeleteAgent(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentsKey(workspaceId) }),
  });
}

export function useTestRun() {
  return useMutation({
    mutationFn: ({ id, ticketKey }: { id: string; ticketKey: string }) => api.testRun(id, ticketKey),
  });
}
