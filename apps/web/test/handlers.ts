import { http, HttpResponse } from 'msw';
import type {
  WorkspaceResponse,
  VerifyResponse,
  StatusesResponse,
  AgentResponse,
} from '@brigadir/contracts';

/**
 * Default msw handlers for `/api/*` — the real HTTP boundary the component tests
 * exercise (quickstart "fake the API with msw, not the store"). Individual tests
 * override these per scenario via `server.use(...)`.
 */

export const sampleWorkspace: WorkspaceResponse = {
  id: 'ws-1',
  name: 'Acme',
  jira_site_url: 'https://acme.atlassian.net',
  project_key: 'BRIG',
  board_id: 42,
  board_type: 'kanban',
  expires_at: '2027-07-12T00:00:00.000Z',
  credential_status: 'ok',
  repositories: [{ name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' }],
  created_at: '2026-07-12T00:00:00.000Z',
  updated_at: '2026-07-12T00:00:00.000Z',
};

export const sampleVerify: VerifyResponse = {
  bot_display_name: 'BRIGADIR Bot',
  project_key: 'BRIG',
  board_id: 42,
  board_type: 'kanban',
};

export const sampleStatuses: StatusesResponse = {
  statuses: [
    { id: '10001', name: 'Ready for Dev', statusCategory: 'new' },
    { id: '3', name: 'In Progress', statusCategory: 'indeterminate' },
    { id: '10002', name: 'In Review', statusCategory: 'indeterminate' },
    { id: '10003', name: 'Blocked', statusCategory: 'new' },
    { id: '10004', name: 'Done', statusCategory: 'done' },
  ],
};

export const sampleAgent: AgentResponse = {
  id: 'ag-1',
  workspace_id: 'ws-1',
  executor_id: 'ex-1',
  name: 'Implementer',
  instruction: 'Implement the ticket.',
  trigger_status: 'Ready for Dev',
  trigger_jql: null,
  status_running: 'In Progress',
  status_success: 'In Review',
  status_failure: 'Blocked',
  behavior: { use_callback_channel: true },
  timeout_minutes: 45,
  max_budget_usd: 5,
  max_attempts: 2,
  enabled: true,
};

export const defaultHandlers = [
  http.get('/api/workspaces', () => HttpResponse.json([sampleWorkspace])),
  http.post('/api/workspaces/verify', () => HttpResponse.json(sampleVerify)),
  http.post('/api/workspaces', () => HttpResponse.json(sampleWorkspace, { status: 201 })),
  http.get('/api/workspaces/:id/statuses', () => HttpResponse.json(sampleStatuses)),
  http.put('/api/workspaces/:id/settings', () => HttpResponse.json(sampleWorkspace)),
  http.put('/api/workspaces/:id/jira-connection', () => HttpResponse.json(sampleWorkspace)),
  http.get('/api/agents', () => HttpResponse.json([sampleAgent])),
  http.post('/api/agents', () => HttpResponse.json(sampleAgent, { status: 201 })),
  http.put('/api/agents/:id', () => HttpResponse.json(sampleAgent)),
  http.post('/api/agents/:id/test-run', () => HttpResponse.json({ run_id: 'run-1' }, { status: 202 })),
];
