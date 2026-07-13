import { http, HttpResponse } from 'msw';
import type {
  WorkspaceResponse,
  VerifyResponse,
  StatusesResponse,
  AgentResponse,
  ExecutorListResponse,
  ExecutorResponse,
  HumanQueueListResponse,
  RunCardResponse,
  RunCostResponse,
  RunListResponse,
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
  // Feature 008 (FR-014): the additive read-only fields the Settings tab renders
  // and its edit modals seed from.
  bot_email: 'bot@acme.io',
  branch_prefix: 'feature',
  scope_jql: 'labels = ai-pipeline',
  enabled: true,
  created_at: '2026-07-12T00:00:00.000Z',
  updated_at: '2026-07-12T00:00:00.000Z',
};

/**
 * A legacy/degraded workspace: null board + expiry + bot_email + config, no
 * repositories. Drives the FR-015 placeholder assertions (Settings tab must
 * render "Not configured" / "No expiry" / em-dash / "No repositories configured"
 * rather than blank or broken rows).
 */
export const nullableWorkspace: WorkspaceResponse = {
  ...sampleWorkspace,
  board_id: null,
  board_type: null,
  expires_at: null,
  bot_email: null,
  branch_prefix: null,
  scope_jql: null,
  repositories: [],
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

// --- feature 006 fixtures ---

export const sampleExecutors: ExecutorResponse[] = [
  {
    id: 'ex-claude',
    type: 'claude_cli',
    name: 'claude',
    enabled: true,
    concurrency_limit: 2,
    config: {
      model: 'claude-sonnet-5',
      cli_path: 'claude',
      repository: 'api',
      use_callback_channel: true,
      keep_failed_worktrees: false,
      max_turns: 30,
    },
  },
  {
    id: 'ex-mock',
    type: 'mock',
    name: 'mock',
    enabled: true,
    concurrency_limit: 1,
    config: {},
  },
];

export const sampleRunListItem: RunListResponse['items'][number] = {
  run_id: 'run-1',
  agent: { id: 'ag-1', name: 'Implementer' },
  ticket: { key: 'BRIG-1', summary: 'Add login', jira_url: 'https://acme.atlassian.net/browse/BRIG-1' },
  status: 'succeeded',
  attempt: 1,
  duration_ms: 42000,
  cost_usd: '0.1234',
  created_at: '2026-07-12T10:00:00.000Z',
};

export const sampleRunList: RunListResponse = {
  items: [sampleRunListItem],
  page: 1,
  page_size: 25,
  total: 1,
};

export const sampleRunCost: RunCostResponse = {
  period: '7d',
  total_cost_usd: '1.2345',
  run_count: 7,
};

export const sampleRunCard: RunCardResponse = {
  run: {
    run_id: 'run-1',
    status: 'failed',
    attempt: 2,
    executor_type: 'claude_cli',
    agent: { id: 'ag-1', name: 'Implementer' },
    duration_ms: 42000,
    cost_usd: '0.1234',
    usage: { input_tokens: 100, output_tokens: 50 },
    outcome: 'failed',
    external_ref: 'https://github.com/acme/api/pull/9',
    error: 'boom: exit code 1\n  at line 42',
    created_at: '2026-07-12T10:00:00.000Z',
    started_at: '2026-07-12T10:00:05.000Z',
    finished_at: '2026-07-12T10:00:47.000Z',
  },
  ticket: { key: 'BRIG-1', summary: 'Add login', jira_url: 'https://acme.atlassian.net/browse/BRIG-1' },
  checks: [
    { position: 0, name: 'lint', status: 'pass', reason: null },
    { position: 1, name: 'tests', status: 'fail', reason: '3 tests failed in auth.spec.ts' },
    { position: 2, name: 'typecheck', status: 'warn', reason: 'deprecated API used' },
    { position: 3, name: 'e2e', status: 'skip', reason: null },
  ],
  events: [
    { id: '1', type: 'started', payload: {}, created_at: '2026-07-12T10:00:05.000Z' },
    { id: '2', type: 'report', payload: { ok: false }, created_at: '2026-07-12T10:00:47.000Z' },
  ],
  history: [
    {
      run_id: 'run-1',
      agent: 'Implementer',
      executor_type: 'claude_cli',
      attempt: 2,
      duration_ms: 42000,
      cost_usd: '0.1234',
      outcome: 'failed',
      status: 'failed',
    },
    {
      run_id: 'run-0',
      agent: 'Implementer',
      executor_type: 'claude_cli',
      attempt: 1,
      duration_ms: 30000,
      cost_usd: '0.0500',
      outcome: 'failed',
      status: 'failed',
    },
  ],
};

export const sampleHumanQueueOpen: HumanQueueListResponse = {
  items: [
    {
      id: 'ht-1',
      kind: 'blocker',
      title: 'Which auth provider?',
      details: 'Need a decision before wiring the callback.',
      blocking: true,
      ticket: { key: 'BRIG-1', jira_url: 'https://acme.atlassian.net/browse/BRIG-1' },
      agent: { id: 'ag-1', name: 'Implementer' },
      run_id: 'run-1',
      created_at: '2026-07-12T09:00:00.000Z',
    },
    {
      id: 'ht-2',
      kind: 'question',
      title: 'Clarify the copy',
      details: null,
      blocking: false,
      ticket: { key: 'BRIG-2', jira_url: 'https://acme.atlassian.net/browse/BRIG-2' },
      agent: null,
      run_id: null,
      created_at: '2026-07-12T09:30:00.000Z',
    },
  ],
};

export const sampleHumanQueueClosed: HumanQueueListResponse = {
  items: [
    {
      id: 'ht-9',
      kind: 'review',
      title: 'Review the migration',
      details: null,
      blocking: false,
      ticket: { key: 'BRIG-9', jira_url: 'https://acme.atlassian.net/browse/BRIG-9' },
      agent: { id: 'ag-1', name: 'Implementer' },
      run_id: 'run-9',
      created_at: '2026-07-11T09:00:00.000Z',
      status: 'resolved',
      resolution: 'Looks good — merged.',
      resolved_by: 'alice',
      resolved_at: '2026-07-11T12:00:00.000Z',
    },
  ],
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

  // executors CRUD (US4)
  http.get('/api/workspaces/:id/executors', () =>
    HttpResponse.json<ExecutorListResponse>({ items: sampleExecutors }),
  ),
  http.post('/api/workspaces/:id/executors', () => HttpResponse.json(sampleExecutors[0], { status: 201 })),
  http.put('/api/workspaces/:id/executors/:executorId', () => HttpResponse.json(sampleExecutors[0])),
  http.delete('/api/workspaces/:id/executors/:executorId', () => new HttpResponse(null, { status: 204 })),

  // runs table + cost + card + cancel/retry (US2/US3)
  http.get('/api/workspaces/:id/runs', () => HttpResponse.json(sampleRunList)),
  http.get('/api/workspaces/:id/runs/cost', () => HttpResponse.json(sampleRunCost)),
  http.get('/api/runs/:id', () => HttpResponse.json(sampleRunCard)),
  http.post('/api/runs/:id/cancel', () => HttpResponse.json({ ok: true, cancelled: true })),
  http.post('/api/runs/:id/retry', () =>
    HttpResponse.json({ ok: true, run_id: 'run-2', deduplicated: false }),
  ),

  // human queue list/count/resolve (US1)
  http.get('/api/human-tasks', ({ request }) => {
    const status = new URL(request.url).searchParams.get('status');
    return HttpResponse.json(status === 'closed' ? sampleHumanQueueClosed : sampleHumanQueueOpen);
  }),
  http.get('/api/human-tasks/count', () => HttpResponse.json({ open: sampleHumanQueueOpen.items.length })),
  http.post('/api/human-tasks/:id/resolve', () =>
    HttpResponse.json({ ok: true, action: 'resume', newRunId: 'run-3' }),
  ),
];
