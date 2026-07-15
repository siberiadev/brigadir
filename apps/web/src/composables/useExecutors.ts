import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type {
  ExecutorCreateRequest,
  ExecutorUpdateRequest,
  PaginationQuery,
} from '@brigadir/contracts';
import { executorsApi } from '../api/executors';

const api = executorsApi();

/** One global cache entry — executors are PLATFORM-scoped (2026-07-13). */
export function executorsKey() {
  return ['executors'] as const;
}

/** Platform executors. Feeds both the Settings admin list and the agent picker. */
export function useExecutors(params: MaybeRefOrGetter<Partial<PaginationQuery>> = {}) {
  return useQuery({
    queryKey: computed(() => [...executorsKey(), toValue(params)]),
    queryFn: () => api.list(toValue(params)),
    placeholderData: (prev) => prev,
  });
}

export function useCreateExecutor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExecutorCreateRequest) => api.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: executorsKey() }),
  });
}

export function useUpdateExecutor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ExecutorUpdateRequest }) => api.update(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: executorsKey() }),
  });
}

export function useDeleteExecutor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: executorsKey() }),
  });
}
