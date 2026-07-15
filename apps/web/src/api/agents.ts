import type {
  AgentListResponse,
  AgentResponse,
  AgentWriteRequest,
  ErrorIssue,
  PaginationQuery,
} from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** An agent write response may carry non-blocking linter warnings (status_cycle). */
export type AgentWriteResponse = AgentResponse & { warnings?: ErrorIssue[] };

export type TestRunResult =
  | { run_id: string; deduplicated?: false; existing_run_id?: undefined }
  | { deduplicated: true; existing_run_id: string; run_id?: undefined };

/** Agents REST resource (contracts/dashboard-api.md — Agents). */
export function agentsApi(client: ApiClient = apiClient) {
  return {
    list: (workspaceId: string, params: Partial<PaginationQuery> = {}) =>
      client.get<AgentListResponse>(`/api/agents${toQuery({ workspace: workspaceId, ...params })}`),
    create: (body: AgentWriteRequest) => client.post<AgentWriteResponse>('/api/agents', body),
    update: (id: string, body: AgentWriteRequest) =>
      client.put<AgentWriteResponse>(`/api/agents/${id}`, body),
    remove: (id: string) => client.del<{ soft_deleted: boolean }>(`/api/agents/${id}`),
    testRun: (id: string, ticketKey: string) =>
      client.post<TestRunResult>(`/api/agents/${id}/test-run`, { ticket_key: ticketKey }),
  };
}
