import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type {
  WorkspaceVerifyRequest,
  WorkspaceCreateRequest,
  WorkspaceRotateRequest,
  WorkspaceSettingsRequest,
} from '@brigadir/contracts';
import { workspacesApi } from '../api/workspaces';

const api = workspacesApi();

export const workspacesKey = ['workspaces'] as const;

export function useWorkspaces() {
  return useQuery({ queryKey: workspacesKey, queryFn: () => api.list() });
}

export function useVerifyWorkspace() {
  return useMutation({ mutationFn: (body: WorkspaceVerifyRequest) => api.verify(body) });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkspaceCreateRequest) => api.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey }),
  });
}

export function useRotateConnection(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkspaceRotateRequest) => api.rotate(workspaceId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey }),
  });
}

export function useUpdateSettings(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkspaceSettingsRequest) => api.updateSettings(workspaceId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey }),
  });
}

/**
 * Enable/pause a workspace from the list (US5). Workspace id travels in the
 * mutation payload so a single instance drives every row (composables can't be
 * called per-row in setup). Writes `settings.enabled` via the settings endpoint.
 */
export function useSetWorkspaceEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }) =>
      api.updateSettings(workspaceId, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspacesKey }),
  });
}
