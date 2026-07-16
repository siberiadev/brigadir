import type {
  HumanQueueCountResponse,
  HumanQueueListResponse,
  HumanQueueStatus,
  PaginationQuery,
  ResolveHumanTaskInput,
} from '@brigadir/contracts';
import { apiClient, toQuery, type ApiClient } from './client';

/** Resolve endpoint response (feature 004 — reused unchanged, guarded in 006). */
export type ResolveResult =
  | { ok: true; action: 'resume'; newRunId: string }
  | { ok: true; action: 'done_manually' | 'dismiss' };

/**
 * Human-queue REST resource (contracts/human-queue-api.md — US1). The list and
 * count are the new 006 read projections; `resolve` is the existing feature-004
 * endpoint (now behind the dashboard guard), reused unchanged.
 */
export function humanTasksApi(client: ApiClient = apiClient) {
  return {
    list: (
      status: HumanQueueStatus = 'open',
      params: Partial<PaginationQuery> = {},
      workspaceId?: string,
    ) =>
      client.get<HumanQueueListResponse>(
        `/api/human-tasks${toQuery({ status, ...params, ...(workspaceId ? { workspace: workspaceId } : {}) })}`,
      ),
    count: () => client.get<HumanQueueCountResponse>('/api/human-tasks/count'),
    resolve: (id: string, body: ResolveHumanTaskInput) =>
      client.post<ResolveResult>(`/api/human-tasks/${id}/resolve`, body),
  };
}
