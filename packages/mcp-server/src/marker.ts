import { writeFile } from 'node:fs/promises';

/**
 * Completion marker (contracts/mcp-config.md, FR-013). Written after a
 * successful `complete_task` or blocking `request_human` 2xx; read by the
 * Stop hook to allow the agent session to end.
 */
export async function writeMarker(markerPath: string): Promise<void> {
  await writeFile(markerPath, new Date().toISOString());
}
