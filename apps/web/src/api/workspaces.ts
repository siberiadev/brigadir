import type {
  PaginationQuery,
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceVerifyRequest,
  VerifyResponse,
  WorkspaceCreateRequest,
  WorkspaceRotateRequest,
  WorkspaceSettingsRequest,
} from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** Workspace REST resource (contracts/dashboard-api.md — Workspaces). */
export function workspacesApi(client: ApiClient = apiClient) {
  return {
    list: (params: Partial<PaginationQuery> = {}) =>
      client.get<WorkspaceListResponse>(`/api/workspaces${toQuery(params)}`),
    get: (id: string) => client.get<WorkspaceResponse>(`/api/workspaces/${id}`),
    verify: (body: WorkspaceVerifyRequest) =>
      client.post<VerifyResponse>('/api/workspaces/verify', body),
    create: (body: WorkspaceCreateRequest) =>
      client.post<WorkspaceResponse>('/api/workspaces', body),
    rotate: (id: string, body: WorkspaceRotateRequest) =>
      client.put<WorkspaceResponse>(`/api/workspaces/${id}/jira-connection`, body),
    updateSettings: (id: string, body: WorkspaceSettingsRequest) =>
      client.put<WorkspaceResponse>(`/api/workspaces/${id}/settings`, body),
    // feature 011: start the orchestrator's workspace-setup run (202 {run_id};
    // 409 worker_agents_exist | no_orchestrator | setup_run_active).
    generateAgents: (id: string) =>
      client.post<{ run_id: string }>(`/api/workspaces/${id}/generate-agents`),
  };
}
