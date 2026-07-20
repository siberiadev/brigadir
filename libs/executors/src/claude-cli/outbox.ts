import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Reader half of the durable-finalize outbox (incident 2026-07-19 Phase 4,
 * Problem 6). The tool server (`packages/mcp-server/src/outbox.ts`) writes each
 * `complete_task` report to `<configRoot>/.brigadir-outbox/<runId>.json` before
 * attempting the HTTP callback. When a callback-wired run would finalize as
 * `timed_out` (the callback never reached the backend), the worker reconciles
 * the real outcome/report from this file instead.
 *
 * The `configRoot` is `defaultMcpConfigRoot(os.tmpdir())` — the same directory
 * whose dirname the tool server derives from `BRIGADIR_MARKER_PATH`. Keep
 * `OUTBOX_DIR_NAME` and the JSON shape in sync with the writer module.
 *
 * The outbox survives `WrittenMcpConfig.cleanup` (which removes only the config
 * and `.marker` files), so it is still on disk when the processor finalizes.
 */
const OUTBOX_DIR_NAME = '.brigadir-outbox';

/** `<configRoot>/.brigadir-outbox/<runId>.json`. */
export function outboxFilePath(configRoot: string, runId: string): string {
  return join(configRoot, OUTBOX_DIR_NAME, `${runId}.json`);
}

/**
 * Read the persisted report for `runId`, or `null` when there is nothing to
 * reconcile: missing file, unparseable JSON, or a `runId` mismatch. Never
 * throws. The report itself is NOT validated here — `finalizeWithReport` does
 * the authoritative `ReportSchema.parse` (the outbox holds the raw tool args).
 */
export async function readOutboxReport(
  configRoot: string,
  runId: string,
): Promise<unknown | null> {
  try {
    const raw = await readFile(outboxFilePath(configRoot, runId), 'utf8');
    const parsed = JSON.parse(raw) as { runId?: unknown; report?: unknown };
    if (parsed?.runId !== runId) return null;
    return parsed.report ?? null;
  } catch {
    return null;
  }
}

/** Best-effort removal after a successful reconcile. Never throws. */
export async function consumeOutbox(configRoot: string, runId: string): Promise<void> {
  try {
    await rm(outboxFilePath(configRoot, runId), { force: true });
  } catch {
    // Best-effort.
  }
}
