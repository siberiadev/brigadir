import type {
  WorkspaceResponse,
  WorkspaceVerifyRequest,
  VerifyResponse,
  WorkspaceCreateRequest,
  WorkspaceRotateRequest,
  WorkspaceSettingsRequest,
} from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/** Workspace REST resource (contracts/dashboard-api.md — Workspaces). */
export function workspacesApi(client: ApiClient = apiClient) {
  return {
    list: () => client.get<WorkspaceResponse[]>('/api/workspaces'),
    verify: (body: WorkspaceVerifyRequest) =>
      client.post<VerifyResponse>('/api/workspaces/verify', body),
    create: (body: WorkspaceCreateRequest) =>
      client.post<WorkspaceResponse>('/api/workspaces', body),
    rotate: (id: string, body: WorkspaceRotateRequest) =>
      client.put<WorkspaceResponse>(`/api/workspaces/${id}/jira-connection`, body),
    updateSettings: (id: string, body: WorkspaceSettingsRequest) =>
      client.put<WorkspaceResponse>(`/api/workspaces/${id}/settings`, body),
  };
}
