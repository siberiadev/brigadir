import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type {
  PaginationQuery,
  WorkspaceVerifyRequest,
  WorkspaceCreateRequest,
  WorkspaceRotateRequest,
  WorkspaceSettingsRequest,
  TicketCountRequest,
  EnvSecretsWriteRequest,
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

/**
 * Live-Jira ticket-count preview (no server-state change → no invalidation,
 * same shape as useVerifyWorkspace). Used by the workspace settings form
 * (scope preview) and the agent form (trigger-status preview).
 */
export function useTicketCount(workspaceId: string) {
  return useMutation({
    mutationFn: (body: TicketCountRequest = {}) => api.ticketCount(workspaceId, body),
  });
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
 * feature 031: write-only secret env for a workspace/repo/agent scope. On
 * success invalidates the workspace detail so masked rows + summaries refresh.
 */
export function useUpdateEnvSecrets(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnvSecretsWriteRequest) => api.updateEnvSecrets(workspaceId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      qc.invalidateQueries({ queryKey: workspaceKey(workspaceId) });
    },
  });
}

/**
 * feature 011: start the orchestrator's workspace-setup run ("Generate
 * agents"). Invalidates the setup-runs query so the button flips to its
 * in-progress state on the next poll tick.
 */
export function useGenerateAgents(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.generateAgents(workspaceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs', workspaceId] });
      qc.invalidateQueries({ queryKey: ['agents'] });
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

/**
 * Feature 020 (D2b): toggle ticket repository scoping via Jira Components for
 * a workspace. Writes `settings.ticket_scoping` via the settings endpoint —
 * same pattern as the enable/pause switch above.
 */
export function useSetTicketScoping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, ticketScoping }: { workspaceId: string; ticketScoping: boolean }) =>
      api.updateSettings(workspaceId, { ticket_scoping: ticketScoping }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      qc.invalidateQueries({ queryKey: workspaceKey(vars.workspaceId) });
    },
  });
}

/**
 * Feature 032: the blocker status at which "is blocked by" dependents may start.
 * `null` clears the setting (back to the done-category rule). Same
 * settings-endpoint pattern as the two toggles above.
 */
export function useSetDependencyReleaseStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, status }: { workspaceId: string; status: string | null }) =>
      api.updateSettings(workspaceId, { dependency_release_status: status }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      qc.invalidateQueries({ queryKey: workspaceKey(vars.workspaceId) });
    },
  });
}
