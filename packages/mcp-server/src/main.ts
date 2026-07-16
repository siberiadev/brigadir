#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CallbackTools } from '@brigadir/contracts';
import { createToolHandlers } from './tools.js';

/**
 * `brigadir-mcp` — stdio MCP server exposing the three callback tools
 * (contracts/mcp-config.md). Zero DB access: a thin client of the backend
 * CallbackModule HTTP API, authenticated with the run token from its OWN env
 * (never argv, never the agent's env — D1). stdout is MCP protocol only; all
 * logs go to stderr.
 */

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
      'Ask a human a question or flag a blocker. Set blocking=true to park the run until answered; ' +
      'blocking=false leaves a note without stopping. Write `details` in GitHub-flavored Markdown ' +
      '(headings, lists, `code`, fenced code blocks, **bold**, links) — it is shown in a rendered ' +
      'viewer, so structure it to be scannable; keep `title` a plain-text one-liner.',
    schema: CallbackTools.request_human,
  },
  {
    name: 'complete_task',
    description:
      'Finish the run with a structured report (outcome, summary, checks, optional artifacts). The single normal way to end a session.',
    schema: CallbackTools.complete_task,
  },
  // feature 011: read-only Jira tools — eyes, not voice. Reads are served by
  // the orchestration system with the workspace's own Jira access; nothing
  // here can write to Jira.
  {
    name: 'get_project_overview',
    description:
      'Read the Jira project overview for this workspace: board type, exact workflow status names, issue types, and the active sprint (if any). Read-only.',
    schema: CallbackTools.get_project_overview,
  },
  {
    name: 'search_tickets',
    description:
      'Search tickets within this workspace (structured filters: text, status, issue_type, max_results ≤ 50). Returns key/summary/status/type/assignee/updated, newest first. Read-only.',
    schema: CallbackTools.search_tickets,
  },
  {
    name: 'get_ticket',
    description:
      'Read one ticket of this workspace by key: summary, description, status, type, labels, links, and the latest comments. Read-only.',
    schema: CallbackTools.get_ticket,
  },
] as const;

const server = new Server({ name: 'brigadir', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    // zod 4 native converter (2026-07-16); target stays draft-07 — the same
    // dialect zod-to-json-schema always emitted for MCP clients here.
    inputSchema: z.toJSONSchema(t.schema, { target: 'draft-7' }) as Record<string, unknown>,
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
    case 'get_project_overview':
      return (await handlers.get_project_overview(args)) as unknown as ServerResult;
    case 'search_tickets':
      return (await handlers.search_tickets(args)) as unknown as ServerResult;
    case 'get_ticket':
      return (await handlers.get_ticket(args)) as unknown as ServerResult;
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
