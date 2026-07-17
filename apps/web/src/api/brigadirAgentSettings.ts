import type { BrigadirAgentSettings } from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/**
 * Brigadir agent settings REST resource (feature 015). Backs the "Brigadir
 * agent" settings tab — the global template of the default orchestrator
 * (seeded into every NEW workspace) plus the two instruction texts relocated
 * from the General tab (routing/triage + workspace setup).
 */
export function brigadirAgentSettingsApi(client: ApiClient = apiClient) {
  return {
    get: () => client.get<BrigadirAgentSettings>('/api/brigadir-agent-settings'),
    update: (body: BrigadirAgentSettings) =>
      client.put<BrigadirAgentSettings>('/api/brigadir-agent-settings', body),
  };
}
