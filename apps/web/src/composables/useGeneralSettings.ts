import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { GeneralSettings } from '@brigadir/contracts';
import { generalSettingsApi } from '../api/generalSettings';

const api = generalSettingsApi();

const KEY = ['general-settings'] as const;

export function useGeneralSettings() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get() });
}

export function useUpdateGeneralSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GeneralSettings) => api.update(body),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}
