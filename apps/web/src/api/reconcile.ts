import type { ReconcileStatusResponse, ReconcileTriggerResponse } from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/**
 * Реконсайл-цикл (Jira-синхронизация): статус расписания для отсчёта на
 * странице Runs + ручной запуск тика («Sync now»).
 */
export function reconcileApi(client: ApiClient = apiClient) {
  return {
    status: () => client.get<ReconcileStatusResponse>('/api/reconcile/status'),
    trigger: () => client.post<ReconcileTriggerResponse>('/api/reconcile/trigger'),
  };
}
