import type { GeneralSettings } from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/**
 * Platform General-settings REST resource (feature 010, FR-021). Backs the
 * "General" settings tab — the default orchestrator instruction copied into new
 * workspaces' orchestrators at creation time.
 */
export function generalSettingsApi(client: ApiClient = apiClient) {
  return {
    get: () => client.get<GeneralSettings>('/api/general-settings'),
    update: (body: GeneralSettings) => client.put<GeneralSettings>('/api/general-settings', body),
  };
}
