#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CallbackTools } from '@brigadir/contracts';
import { createToolHandlers } from './tools.js';

/**
 * `brigadir-mcp` — stdio MCP server exposing the three callback tools
 * (contracts/mcp-config.md). Zero DB access: a thin client of the backend
 * CallbackModule HTTP API, authenticated with the run token from its OWN env
 * (never argv, never the agent's env — D1). stdout is MCP protocol only; all
 * logs go to stderr.
 */

const zodToJsonSchemaUntyped = zodToJsonSchema as unknown as (
  schema: unknown,
  options?: unknown,
) => Record<string, unknown>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`brigadir-mcp: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

const runId = requireEnv('BRIGADIR_RUN_ID');
const callbackUrl = requireEnv('BRIGADIR_CALLBACK_URL');
const runToken = requireEnv('BRIGADIR_RUN_TOKEN');
const markerPath = requireEnv('BRIGADIR_MARKER_PATH');

const handlers = createToolHandlers({ callbackUrl, runId, runToken, markerPath });

const TOOL_DEFS = [
  {
    name: 'report_progress',
    description: 'Report progress on the current stage of work. Does not change run status.',
    schema: CallbackTools.report_progress,
  },
  {
    name: 'request_human',
    description:
      'Ask a human a question or flag a blocker. Set blocking=true to park the run until answered; blocking=false leaves a note without stopping.',
    schema: CallbackTools.request_human,
  },
  {
    name: 'complete_task',
    description:
      'Finish the run with a structured report (outcome, summary, checks, optional artifacts). The single normal way to end a session.',
    schema: CallbackTools.complete_task,
  },
] as const;

const server = new Server({ name: 'brigadir', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchemaUntyped(t.schema, { target: 'jsonSchema7' }),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<ServerResult> => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'report_progress':
      return (await handlers.report_progress(args)) as unknown as ServerResult;
    case 'request_human':
      return (await handlers.request_human(args)) as unknown as ServerResult;
    case 'complete_task':
      return (await handlers.complete_task(args)) as unknown as ServerResult;
    default:
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      } as unknown as ServerResult;
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`brigadir-mcp: fatal: ${String(err)}`);
  process.exit(1);
});
