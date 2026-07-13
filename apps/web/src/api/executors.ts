import type {
  ExecutorCreateRequest,
  ExecutorListResponse,
  ExecutorResponse,
  ExecutorUpdateRequest,
} from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/** Executors REST resource (contracts/executors-api.md — US4, workspace-scoped CRUD). */
export function executorsApi(client: ApiClient = apiClient) {
  return {
    list: (workspaceId: string) =>
      client.get<ExecutorListResponse>(`/api/workspaces/${workspaceId}/executors`),
    create: (workspaceId: string, body: ExecutorCreateRequest) =>
      client.post<ExecutorResponse>(`/api/workspaces/${workspaceId}/executors`, body),
    update: (workspaceId: string, executorId: string, body: ExecutorUpdateRequest) =>
      client.put<ExecutorResponse>(`/api/workspaces/${workspaceId}/executors/${executorId}`, body),
    remove: (workspaceId: string, executorId: string) =>
      client.del<void>(`/api/workspaces/${workspaceId}/executors/${executorId}`),
  };
}
