import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { reconcileApi } from '../api/reconcile';

const api = reconcileApi();

/**
 * Расписание реконсайл-цикла для отсчёта «Next sync in …». 5-секундный
 * поллинг (как useRuns на той же странице) — next_run_at обновляется в
 * пределах одного интервала после каждого тика.
 */
export function useReconcileStatus() {
  return useQuery({
    queryKey: ['reconcile-status'],
    queryFn: () => api.status(),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });
}

/**
 * «Sync now»: ручной тик реконсайла. Инвалидирует статус (last_run_at) и
 * списки прогонов — новые прогоны от тика появляются без ожидания поллинга.
 */
export function useTriggerReconcile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.trigger(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reconcile-status'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
}
