import type { TicketHistoryRun } from '@brigadir/contracts';

/**
 * Pure view-model builder for the ticket-history page (no Vue imports — unit
 * tested directly, RunTimeline/presenter.ts pattern). Groups the flat
 * chronological run list into the main pass plus collapsed "rework cycles":
 * a triage run (orchestrator deciding on a failed run) plus the rework run(s)
 * it dispatched. Grouping is derived from the causal trigger references —
 * `failing_run_id` links a triage run to the fail it judges, `deciding_run_id`
 * links a rework run to the triage that dispatched it. Broken references
 * degrade gracefully: an orphan lands in the main flow, nothing throws.
 */

export interface RunBlock {
  kind: 'run';
  run: TicketHistoryRun;
}

export interface CycleBlock {
  kind: 'cycle';
  /** 1-based rework-cycle ordinal for the "Rework cycle N" header. */
  index: number;
  triage: TicketHistoryRun;
  reworks: TicketHistoryRun[];
}

export type HistoryBlock = RunBlock | CycleBlock;

export interface TicketHistoryViewModel {
  blocks: HistoryBlock[];
}

/** Sources whose runs OPEN a cycle: an orchestrator judging a failed run. */
const CYCLE_OPENERS: ReadonlySet<string> = new Set(['triage', 'answer-triage']);

/** Short human label for the run's trigger ("poll", "triage", "rework", …). */
export function triggerLabel(run: TicketHistoryRun): string {
  return run.trigger.source ?? 'manual';
}

export function presentHistory(runs: TicketHistoryRun[]): TicketHistoryViewModel {
  const blocks: HistoryBlock[] = [];
  // triage run_id → its cycle block, for attaching reworks by deciding_run_id.
  const cycleByTriageId = new Map<string, CycleBlock>();
  let cycleCount = 0;

  for (const run of runs) {
    const source = run.trigger.source;

    if (source && CYCLE_OPENERS.has(source) && run.trigger.failing_run_id) {
      cycleCount += 1;
      const cycle: CycleBlock = { kind: 'cycle', index: cycleCount, triage: run, reworks: [] };
      cycleByTriageId.set(run.run_id, cycle);
      blocks.push(cycle);
      continue;
    }

    if (source === 'rework' && run.trigger.deciding_run_id) {
      const cycle = cycleByTriageId.get(run.trigger.deciding_run_id);
      if (cycle) {
        cycle.reworks.push(run);
        continue;
      }
      // Broken deciding reference — fall through to the main flow.
    }

    blocks.push({ kind: 'run', run });
  }

  return { blocks };
}
