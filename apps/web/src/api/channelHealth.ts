import type { ChannelHealthResponse } from '@brigadir/contracts';
import { apiClient, type ApiClient } from './client';

/**
 * Channel-health REST resource (feature 027, contracts/channel-health-api.md).
 * Один additive read-only агрегат для индикатора в сайдбаре. Read-only.
 */
export function channelHealthApi(client: ApiClient = apiClient) {
  return {
    get: () => client.get<ChannelHealthResponse>('/api/channel-health'),
  };
}
