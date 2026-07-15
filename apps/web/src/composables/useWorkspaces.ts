import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type {
  PaginationQuery,
  WorkspaceVerifyRequest,
  WorkspaceCreateRequest,
  WorkspaceRotateRequest,
  WorkspaceSettingsRequest,
} from '@brigadir/contracts';
import { workspacesApi } from '../api/workspaces';

const api = workspacesApi();

export const workspacesKey = ['workspaces'] as const;

export function workspaceKey(id: string) {
  return ['workspace', id] as const;
}

export function useWorkspaces(params: MaybeRefOrGetter<Partial<PaginationQuery>> = {}) {
  return useQuery({
    queryKey: computed(() => [...workspacesKey, toValue(params)]),
    queryFn: () => api.list(toValue(params)),
    placeholderData: (prev) => prev,
  });
}

/**
 * Точечный detail-запрос (реш. 2026-07-15): потребители «одного workspace»
 * (шапка, настройки, лукапы по id) НЕ ищут его в пагинированном списке.
 */
export function useWorkspace(id: string) {
  return useQuery({ queryKey: workspaceKey(id), queryFn: () => api.get(id) });
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      qc.invalidateQueries({ queryKey: workspaceKey(workspaceId) });
    },
  });
}

export function useUpdateSettings(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkspaceSettingsRequest) => api.updateSettings(workspaceId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      qc.invalidateQueries({ queryKey: workspaceKey(workspaceId) });
    },
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
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      qc.invalidateQueries({ queryKey: workspaceKey(vars.workspaceId) });
    },
  });
}
