import type { FunctionalComponent } from 'vue';
import { CircleHelp, OctagonAlert, SearchCheck } from 'lucide-vue-next';
import type { HumanQueueItem, HumanQueueKind } from '@brigadir/contracts';

/** el-tag `type` per task kind — used by the drawer header. */
export const kindTagType: Record<HumanQueueKind, string> = {
  blocker: 'danger',
  question: 'warning',
  review: 'info',
};

/** Icon glyph per task kind — the queue row's square badge. */
export const kindIcon: Record<HumanQueueKind, FunctionalComponent> = {
  blocker: OctagonAlert,
  question: CircleHelp,
  review: SearchCheck,
};

export type BadgeState = 'blocking' | 'waiting' | 'resolved' | 'dismissed';

/**
 * The badge STATE drives the row icon's color, independent of `kind` (the
 * glyph): it encodes whether a run is parked. `blocking` (red) parked the run
 * and a resolve resumes it; `waiting` (amber) queued a note without parking a
 * run; closed tasks show their outcome — `resolved` (green) / `dismissed`
 * (grey). The blocking↔kind distinction stays in the data; the color surfaces
 * the parked state without a separate text tag.
 */
export function badgeState(item: HumanQueueItem): BadgeState {
  if (item.status === 'resolved') return 'resolved';
  if (item.status === 'dismissed') return 'dismissed';
  return item.blocking ? 'blocking' : 'waiting';
}

/** Hover copy per badge state — explains what resolving does (or doesn't do). */
export const badgeTooltip: Record<BadgeState, string> = {
  blocking: 'Run parked — resolve resumes it',
  waiting: 'Not blocking a run',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
