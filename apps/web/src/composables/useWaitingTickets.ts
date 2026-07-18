import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { PaginationQuery } from '@brigadir/contracts';
import { ticketsApi } from '../api/tickets';

const api = ticketsApi();

export function waitingTicketsKey(workspaceId: string) {
  return ['waiting-tickets', workspaceId] as const;
}

/** Blocked-waiting tickets of a workspace (feature 022, US3). */
export function useWaitingTickets(
  workspaceId: string,
  params: MaybeRefOrGetter<Partial<PaginationQuery>> = {},
) {
  return useQuery({
    queryKey: computed(() => [...waitingTicketsKey(workspaceId), toValue(params)]),
    queryFn: () => api.waiting(workspaceId, toValue(params)),
    placeholderData: (prev) => prev,
  });
}
