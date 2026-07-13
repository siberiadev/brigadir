import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { RunCardResponse, RunStatus } from '@brigadir/contracts';
import { runsApi } from '../api/runs';

const api = runsApi();

export function runCardKey(runId: string) {
  return ['run-card', runId] as const;
}

/** A run in a terminal state never polls (its card is frozen). */
const TERMINAL: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'superseded',
]);

/**
 * The run/ticket card (US2). Live via `refetchInterval` while the run is
 * non-terminal (~3 s); once terminal the interval turns off. Cancel + retry
 * mutations invalidate the card so its status/history refresh.
 */
export function useRunCard(runId: string) {
  return useQuery({
    queryKey: runCardKey(runId),
    queryFn: () => api.card(runId),
    refetchInterval: (query) => {
      const status = (query.state.data as RunCardResponse | undefined)?.run.status;
      return status && TERMINAL.has(status) ? false : 3000;
    },
  });
}

export function useCancelRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancel(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: runCardKey(runId) }),
  });
}

export function useRetryRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retry(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: runCardKey(runId) }),
  });
}
