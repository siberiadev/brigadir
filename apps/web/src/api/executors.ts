import type {
  ExecutorCreateRequest,
  ExecutorListResponse,
  ExecutorResponse,
  ExecutorUpdateRequest,
} from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/** Executors REST resource — PLATFORM-scoped CRUD (2026-07-13), no workspace in the path. */
export function executorsApi(client: ApiClient = apiClient) {
  return {
    list: () => client.get<ExecutorListResponse>('/api/executors'),
    create: (body: ExecutorCreateRequest) => client.post<ExecutorResponse>('/api/executors', body),
    update: (executorId: string, body: ExecutorUpdateRequest) =>
      client.put<ExecutorResponse>(`/api/executors/${executorId}`, body),
    remove: (executorId: string) => client.del<void>(`/api/executors/${executorId}`),
  };
}
