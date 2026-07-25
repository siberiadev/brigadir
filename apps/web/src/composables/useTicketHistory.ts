import { useQuery } from '@tanstack/vue-query';
import type { RunStatus, TicketHistoryResponse } from '@brigadir/contracts';
import { ticketsApi } from '../api/tickets';

const api = ticketsApi();

export function ticketHistoryKey(workspaceId: string, key: string) {
  return ['ticket-history', workspaceId, key] as const;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'superseded',
]);

/**
 * The ticket-history page data. Live via `refetchInterval` while any run of
 * the ticket is non-terminal (same 3 s cadence as the run card); a fully
 * settled history stops polling.
 */
export function useTicketHistory(workspaceId: string, key: string) {
  return useQuery({
    queryKey: ticketHistoryKey(workspaceId, key),
    queryFn: () => api.history(workspaceId, key),
    refetchInterval: (query) => {
      const runs = (query.state.data as TicketHistoryResponse | undefined)?.runs;
      if (!runs) return false;
      return runs.some((r) => !TERMINAL.has(r.status)) ? 3000 : false;
    },
  });
}
