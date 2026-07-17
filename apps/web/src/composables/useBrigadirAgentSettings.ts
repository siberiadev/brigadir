import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { BrigadirAgentSettings } from '@brigadir/contracts';
import { brigadirAgentSettingsApi } from '../api/brigadirAgentSettings';

const api = brigadirAgentSettingsApi();

const KEY = ['brigadir-agent-settings'] as const;

export function useBrigadirAgentSettings() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get() });
}

export function useUpdateBrigadirAgentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BrigadirAgentSettings) => api.update(body),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}
