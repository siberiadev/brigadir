#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AdminTools, type AdminToolName } from '@brigadir/contracts';
import { createToolHandlers, type AdminToolHandlers } from './tools.js';

/**
 * `brigadir-admin` — stdio MCP server for the admin plane (feature 012). A human
 * plugs it into Claude Code and asks "assemble a team for this board"; Claude
 * creates the workspace + agents through these tools. It is a THIN HTTP client of
 * the dashboard admin API (zero DB access), authenticated with the dashboard
 * bearer from its OWN env.
 *
 * Line vs the callback MCP (`brigadir-mcp`): that one is for an agent INSIDE a run
 * (run JWT, callback tools). This one is for a human+Claude OUTSIDE any run
 * (dashboard bearer, create workspaces/agents). Secrets live ONLY in env — never
 * in a tool argument (Principle V). stdout is MCP protocol only; logs go to stderr.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`brigadir-admin: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

const apiUrl = requireEnv('BRIGADIR_API_URL');
const dashboardToken = requireEnv('BRIGADIR_DASHBOARD_TOKEN');
const jiraEmail = requireEnv('BRIGADIR_JIRA_EMAIL');
const jiraApiToken = requireEnv('BRIGADIR_JIRA_API_TOKEN');

const handlers = createToolHandlers({ apiUrl, dashboardToken, jiraEmail, jiraApiToken });

const TOOL_NAMES = Object.keys(AdminTools) as AdminToolName[];

const server = new Server({ name: 'brigadir-admin', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_NAMES.map((name) => {
    const def = AdminTools[name];
    return {
      name,
      description: def.description,
      // zod 4 native converter; target pinned to draft-07 (the wire dialect the
      // repo's MCP clients already consume — iteration 16).
      inputSchema: z.toJSONSchema(def.input, { target: 'draft-7' }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(def.output, { target: 'draft-7' }) as Record<string, unknown>,
    };
  }),
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ServerResult> => {
  const { name, arguments: args } = request.params;
  if (!(name in AdminTools)) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true } as unknown as ServerResult;
  }
  const handler = handlers[name as keyof AdminToolHandlers];
  return (await handler(args ?? {})) as unknown as ServerResult;
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`brigadir-admin: fatal: ${String(err)}`);
  process.exit(1);
});
