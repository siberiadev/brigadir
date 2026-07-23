import type {
  AgentInstructionsGlobalSettings,
  AgentInstructionsGlobalUpdate,
} from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/**
 * Global agent role-template source (feature 030). Backs the "Agent instruction
 * templates" card on the platform General settings. The token is write-only:
 * GET returns only `has_token`; PUT is tri-state (absent keep, null/"" clear,
 * value replace) on both `source` and `token`.
 */
export function agentInstructionsSettingsApi(client: ApiClient = apiClient) {
  return {
    get: () => client.get<AgentInstructionsGlobalSettings>('/api/agent-instructions-settings'),
    update: (body: AgentInstructionsGlobalUpdate) =>
      client.put<AgentInstructionsGlobalSettings>('/api/agent-instructions-settings', body),
  };
}
