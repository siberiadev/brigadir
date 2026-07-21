import { useQuery } from '@tanstack/vue-query';
import { toValue, type MaybeRefOrGetter } from 'vue';
import { channelHealthApi } from '../api/channelHealth';

const api = channelHealthApi();

/**
 * Channel-health индикатор (feature 027, US4): 5-секундный поллинг — SC-004
 * «дашборд отражает degraded в пределах одного интервала». Включается только
 * после аутентификации (как useHumanTaskCount — bearer не гоняем зря).
 */
export function useChannelHealth(enabled: MaybeRefOrGetter<boolean>) {
  return useQuery({
    queryKey: ['channel-health'],
    queryFn: () => api.get(),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
    enabled: () => toValue(enabled),
  });
}
