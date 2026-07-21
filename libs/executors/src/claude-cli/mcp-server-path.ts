import { join } from 'node:path';

/**
 * Resolution of the agent tool-server ("brigadir-mcp") artifact and its
 * sources (feature 026, research D2). Extracted from the executor's private
 * method so the deployment guard checks the exact file the executor spawns.
 * Both paths are overridable via env for deployments and integration tests.
 */

/** The built `packages/mcp-server/dist/main.js` the executor spawns. */
export function resolveMcpServerEntryPath(): string {
  return (
    process.env.BRIGADIR_MCP_SERVER_ENTRY ??
    join(process.cwd(), 'packages', 'mcp-server', 'dist', 'main.js')
  );
}

/** The tool-server source tree — the freshness baseline for the deployment guard. */
export function resolveMcpServerSrcDir(): string {
  return process.env.BRIGADIR_MCP_SERVER_SRC ?? join(process.cwd(), 'packages', 'mcp-server', 'src');
}
