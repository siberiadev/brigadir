import type {
  ExecutorCreateRequest,
  ExecutorListResponse,
  ExecutorResponse,
  ExecutorUpdateRequest,
  PaginationQuery,
} from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** Executors REST resource — PLATFORM-scoped CRUD (2026-07-13), no workspace in the path. */
export function executorsApi(client: ApiClient = apiClient) {
  return {
    list: (params: Partial<PaginationQuery> = {}) =>
      client.get<ExecutorListResponse>(`/api/executors${toQuery(params)}`),
    create: (body: ExecutorCreateRequest) => client.post<ExecutorResponse>('/api/executors', body),
    update: (executorId: string, body: ExecutorUpdateRequest) =>
      client.put<ExecutorResponse>(`/api/executors/${executorId}`, body),
    remove: (executorId: string) => client.del<void>(`/api/executors/${executorId}`),
  };
}
