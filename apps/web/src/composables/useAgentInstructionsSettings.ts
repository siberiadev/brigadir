import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { AgentInstructionsGlobalUpdate } from '@brigadir/contracts';
import { agentInstructionsSettingsApi } from '../api/agentInstructionsSettings';

const api = agentInstructionsSettingsApi();

const KEY = ['agent-instructions-settings'] as const;

export function useAgentInstructionsSettings() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get() });
}

export function useUpdateAgentInstructionsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentInstructionsGlobalUpdate) => api.update(body),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}
