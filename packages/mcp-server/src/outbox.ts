import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Durable-finalize outbox (incident 2026-07-19 Phase 4, Problem 6). On every
 * `complete_task` the tool server writes the raw report to a local file NEXT TO
 * `BRIGADIR_MARKER_PATH`, before attempting the HTTP callback. If the callback
 * never reaches the backend (the incident: `TypeError: fetch failed`), the run
 * would finalize as `timed_out` with `outcome = NULL` and the report would be
 * lost — the worker instead reconciles it from this file.
 *
 * On-disk contract with the reader in the worker
 * (`libs/executors/src/claude-cli/outbox.ts`): a `<marker-dir>/.brigadir-outbox/`
 * subdirectory holding `<runId>.json`. The two runtimes are separate packages
 * and agree by convention (like `BRIGADIR_MARKER_PATH` itself is a string
 * contract across the boundary) — keep `OUTBOX_DIR_NAME` and the JSON shape in
 * sync with that module.
 *
 * Invariant: an outbox file exists iff completion happened locally but was NOT
 * confirmed by the backend — written before the POST, removed on a 2xx.
 */
const OUTBOX_DIR_NAME = '.brigadir-outbox';

/** `<dirname(markerPath)>/.brigadir-outbox/<runId>.json`. */
export function outboxFilePath(markerPath: string, runId: string): string {
  return join(dirname(markerPath), OUTBOX_DIR_NAME, `${runId}.json`);
}

/**
 * Persist the report to the outbox. Best-effort: any failure is swallowed (a
 * completion must never fail because of the outbox). `report` is the raw tool
 * `args` (validated server-side only), so `outcome` is read defensively.
 */
export async function writeOutbox(
  markerPath: string,
  runId: string,
  report: unknown,
): Promise<void> {
  try {
    const file = outboxFilePath(markerPath, runId);
    await mkdir(dirname(file), { recursive: true });
    const outcome = (report as { outcome?: unknown } | null | undefined)?.outcome;
    const payload = { runId, outcome, report, timestamp: new Date().toISOString() };
    await writeFile(file, JSON.stringify(payload));
  } catch {
    // Best-effort — the durable fallback is a safety net, never a blocker.
  }
}

/** Best-effort removal once the callback is confirmed (2xx). Never throws. */
export async function removeOutbox(markerPath: string, runId: string): Promise<void> {
  try {
    await rm(outboxFilePath(markerPath, runId), { force: true });
  } catch {
    // Best-effort.
  }
}
