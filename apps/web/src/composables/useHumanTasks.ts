import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type {
  HumanQueueStatus,
  PaginationQuery,
  ResolveHumanTaskInput,
} from '@brigadir/contracts';
import { humanTasksApi } from '../api/humanTasks';

const api = humanTasksApi();

export function humanTasksKey(status: HumanQueueStatus) {
  return ['human-tasks', status] as const;
}
export const humanTasksCountKey = ['human-tasks', 'count'] as const;

/**
 * The needs-human queue (US1). Live via TanStack `refetchInterval` polling
 * (research R1 — no SSE, no bearer in any URL). The open list refreshes on a
 * short cadence so a resolved task drops off; closed history does not poll.
 */
export function useHumanTasks(
  status: HumanQueueStatus = 'open',
  params: MaybeRefOrGetter<Partial<PaginationQuery>> = {},
  workspaceId: MaybeRefOrGetter<string | undefined> = undefined,
) {
  return useQuery({
    // workspaceId is part of the key so the global queue and a workspace-scoped
    // tab keep separate caches.
    queryKey: computed(() => [...humanTasksKey(status), toValue(workspaceId), toValue(params)]),
    queryFn: () => api.list(status, toValue(params), toValue(workspaceId)),
    refetchInterval: status === 'open' ? 4000 : false,
    placeholderData: (prev) => prev,
  });
}

/** The navbar badge count (~3 s live). `enabled` gates it behind the token. */
export function useHumanTaskCount(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: humanTasksCountKey,
    queryFn: () => api.count(),
    refetchInterval: 3000,
    enabled: () => toValue(enabled),
  });
}

/** Resolve (resume / done_manually / dismiss) — invalidates the open list + count. */
export function useResolveHumanTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ResolveHumanTaskInput }) => api.resolve(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: humanTasksKey('open') });
      qc.invalidateQueries({ queryKey: humanTasksCountKey });
    },
  });
}
