import { http, HttpResponse } from 'msw';
import type {
  AgentListResponse,
  WorkspaceListResponse,
  WorkspaceResponse,
  VerifyResponse,
  StatusesResponse,
  AgentResponse,
  ExecutorListResponse,
  ExecutorResponse,
  GlobalRunsResponse,
  HomeSummaryResponse,
  HomeWorkspacesResponse,
  HumanQueueListResponse,
  RunCardResponse,
  RunCostResponse,
  RunListResponse,
} from '@brigadir/contracts';

/** Обернуть элементы в единый пагинированный конверт (реш. 2026-07-15). */
export function paginated<T>(items: T[], page = 1, pageSize = 10) {
  return { items, page, page_size: pageSize, total: items.length };
}

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
  // Feature 020 (D2b): ticket repository scoping — OFF by default.
  ticket_scoping: false,
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
  key: 'implementer',
  role: null,
  description: null,
  is_orchestrator: false,
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

/**
 * Feature 016: an agent WITH a role and a resolvable executor (`ex-claude` is in
 * `sampleExecutors`). `sampleAgent` above stays role-less with a dangling
 * `executor_id` ('ex-1' matches no executor fixture) — together they drive the
 * Role-tag / Executor-name columns and both empty-cell fallbacks.
 */
export const sampleAgentWithRole: AgentResponse = {
  ...sampleAgent,
  id: 'ag-2',
  executor_id: 'ex-claude',
  name: 'Vera',
  key: 'reviewer',
  role: 'reviewer',
  trigger_status: 'In Review',
  status_running: 'In Review',
  status_success: 'Done',
};

// --- executor fixtures (named runner profiles, 2026-07-14: has_api_key, no repository) ---

export const sampleExecutors: ExecutorResponse[] = [
  {
    id: 'ex-claude',
    type: 'claude_cli',
    name: 'claude',
    enabled: true,
    max_parallel_runs: 2,
    has_api_key: false,
    config: {
      model: 'claude-sonnet-5',
      cli_path: 'claude',
      use_callback_channel: true,
      keep_failed_worktrees: false,
      max_turns: 30,
      // Feature 018: responses always carry the EFFECTIVE auth mode.
      auth: 'host_subscription',
    },
  },
  {
    id: 'ex-mock',
    type: 'mock',
    name: 'mock',
    enabled: true,
    max_parallel_runs: 1,
    has_api_key: false,
    config: {},
  },
];

/** A claude_cli profile WITH a stored key + a DISABLED profile — picker/form state fixtures. */
export const sampleExecutorWithKey: ExecutorResponse = {
  id: 'ex-team',
  type: 'claude_cli',
  name: 'team-api-key',
  enabled: true,
  max_parallel_runs: 4,
  has_api_key: true,
  config: {
    model: 'claude-opus-4-8',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 40,
    // Feature 018: a stored key defaults the effective mode to api_key.
    auth: 'api_key',
  },
};

/** Feature 018: a bedrock-mode profile — corporate Claude through AWS Bedrock. */
export const sampleExecutorBedrock: ExecutorResponse = {
  id: 'ex-bedrock',
  type: 'claude_cli',
  name: 'corp-bedrock',
  enabled: true,
  max_parallel_runs: 2,
  has_api_key: false,
  config: {
    model: 'eu.anthropic.claude-opus-4-8',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 30,
    auth: 'bedrock',
    aws_region: 'eu-west-1',
    aws_profile: 'corp-dev',
    ca_bundle_path: '/etc/ssl/corp/ca-bundle.pem',
  },
};

export const sampleDisabledExecutor: ExecutorResponse = {
  id: 'ex-off',
  type: 'claude_cli',
  name: 'paused-runner',
  enabled: false,
  max_parallel_runs: 1,
  has_api_key: false,
  config: {
    model: 'claude-sonnet-5',
    cli_path: 'claude',
    use_callback_channel: true,
    keep_failed_worktrees: false,
    max_turns: 30,
  },
};

export const sampleRunListItem: RunListResponse['items'][number] = {
  run_id: 'run-1',
  agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
  ticket: { key: 'BRIG-1', summary: 'Add login', jira_url: 'https://acme.atlassian.net/browse/BRIG-1' },
  status: 'succeeded',
  attempt: 1,
  executor_type: 'claude_cli',
  duration_ms: 42000,
  started_at: '2026-07-12T10:00:05.000Z',
  cost_usd: '0.1234',
  created_at: '2026-07-12T10:00:00.000Z',
  callback_alert: false,
};

/** A currently-active run — pulse dot + live-ticking Duration in the table.
 * Its agent carries a `role` (feature 016) so runs fixtures cover both the
 * role and the em-dash fallback (sampleRunListItem keeps `role: null`). */
export const sampleRunningListItem: RunListResponse['items'][number] = {
  run_id: 'run-2',
  agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: 'developer' },
  ticket: { key: 'BRIG-2', summary: 'Fix logout', jira_url: 'https://acme.atlassian.net/browse/BRIG-2' },
  status: 'running',
  attempt: 1,
  executor_type: 'claude_cli',
  duration_ms: 5000,
  started_at: '2026-07-12T11:00:00.000Z',
  cost_usd: null,
  created_at: '2026-07-12T11:00:00.000Z',
  callback_alert: false,
};

export const sampleRunList: RunListResponse = {
  items: [sampleRunListItem],
  page: 1,
  page_size: 10,
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
    workspace_id: 'ws-1',
    status: 'failed',
    attempt: 2,
    executor_type: 'claude_cli',
    agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
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
  // Feature 019: per-repo artifact lines (normalized by the backend).
  artifacts: [
    {
      repo: 'api',
      branch: 'feat/BRIG-1',
      pr_url: 'https://github.com/acme/api/pull/9',
      commits_count: 2,
      files_changed: 5,
    },
    { repo: 'web', branch: 'feat/BRIG-1', pr_url: null, commits_count: 1, files_changed: null },
  ],
  events: [
    { id: '1', type: 'started', payload: {}, created_at: '2026-07-12T10:00:05.000Z' },
    { id: '2', type: 'report', payload: { ok: false }, created_at: '2026-07-12T10:00:47.000Z' },
    {
      id: '3',
      type: 'log',
      payload: {
        model: 'claude-sonnet-5',
        session_id: 's-1',
        tools: ['Bash', 'Edit'],
        mcp_servers: [{ name: 'brigadir', status: 'connected' }],
      },
      created_at: '2026-07-12T10:00:06.000Z',
    },
    {
      id: '4',
      type: 'progress',
      payload: { message: 'Implementing the fix', stage: 'implement', percent: 40 },
      created_at: '2026-07-12T10:00:10.000Z',
    },
    {
      id: '5',
      type: 'tool_call',
      // claude-cli path: input arrives as a JSON.stringify'd string, not an object.
      payload: {
        name: 'Bash',
        input: JSON.stringify({ command: 'pnpm test', description: 'Run unit tests' }),
      },
      created_at: '2026-07-12T10:00:20.000Z',
    },
    {
      id: '6',
      type: 'jira_action',
      payload: { commented: true, transitioned_to: 'Review' },
      created_at: '2026-07-12T10:00:46.000Z',
    },
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
  page: 1,
  page_size: 10,
  total: 2,
  items: [
    {
      id: 'ht-1',
      kind: 'blocker',
      title: 'Which auth provider?',
      details: '## Decision needed\n\nPick one before wiring `request_human`:\n\n- **OAuth** — more setup\n- **Basic** — quicker',
      options: null,
      blocking: true,
      ticket: { key: 'BRIG-1', jira_url: 'https://acme.atlassian.net/browse/BRIG-1' },
      agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
      workspace: { id: 'ws-1', name: 'Acme' },
      run_id: 'run-1',
      created_at: '2026-07-12T09:00:00.000Z',
    },
    {
      id: 'ht-2',
      kind: 'question',
      title: 'Clarify the copy',
      details: null,
      options: null,
      blocking: false,
      ticket: { key: 'BRIG-2', jira_url: 'https://acme.atlassian.net/browse/BRIG-2' },
      agent: null,
      workspace: { id: 'ws-1', name: 'Acme' },
      run_id: null,
      created_at: '2026-07-12T09:30:00.000Z',
    },
  ],
};

/**
 * Feature 013: an open blocking task carrying suggested answer options — one
 * full option (value + description), one label-only (value defaults to label
 * at click time), one with a value but no description. Used via `server.use`
 * so the default fixtures above keep proving the no-options rendering.
 */
export const sampleHumanTaskWithOptions: HumanQueueListResponse['items'][number] = {
  id: 'ht-opt',
  kind: 'question',
  title: 'Which migration strategy?',
  details: 'The config format change can break older readers.',
  options: [
    { label: 'Migrate config format', value: 'migrate', description: 'Breaking, needs a major bump' },
    { label: 'Keep backward compat' },
    { label: 'Ask the team first', value: 'defer' },
  ],
  blocking: true,
  ticket: { key: 'BRIG-3', jira_url: 'https://acme.atlassian.net/browse/BRIG-3' },
  agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
  workspace: { id: 'ws-1', name: 'Acme' },
  run_id: 'run-3',
  created_at: '2026-07-12T10:00:00.000Z',
};

export const sampleHumanQueueClosed: HumanQueueListResponse = {
  page: 1,
  page_size: 10,
  total: 1,
  items: [
    {
      id: 'ht-9',
      kind: 'review',
      title: 'Review the migration',
      details: null,
      options: null,
      blocking: false,
      ticket: { key: 'BRIG-9', jira_url: 'https://acme.atlassian.net/browse/BRIG-9' },
      agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
      workspace: { id: 'ws-1', name: 'Acme' },
      run_id: 'run-9',
      created_at: '2026-07-11T09:00:00.000Z',
      status: 'resolved',
      resolution: 'Looks good — merged.',
      resolved_by: 'alice',
      resolved_at: '2026-07-11T12:00:00.000Z',
    },
  ],
};

// --- Home dashboard fixtures (feature 017) ---

export const sampleHomeSummary: HomeSummaryResponse = {
  running: 2,
  queued: 1,
  attention_24h: { failed: 1, timed_out: 1 },
  human_open: 2,
  spend: {
    '24h': { total_cost_usd: '18.4200', run_count: 37 },
    '7d': { total_cost_usd: '96.1000', run_count: 214 },
    '30d': { total_cost_usd: '342.7700', run_count: 861 },
  },
};

/** Live list: two running (one long-running first) + one queued, server-ordered. */
export const sampleGlobalRunsLive: GlobalRunsResponse = {
  items: [
    {
      run_id: 'run-live-1',
      agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
      ticket: { key: 'BRIG-10', summary: 'Split report', jira_url: 'https://acme.atlassian.net/browse/BRIG-10' },
      workspace: { id: 'ws-1', name: 'Acme' },
      status: 'running',
      attempt: 1,
      duration_ms: null,
      started_at: '2026-07-12T10:00:00.000Z',
      finished_at: null,
      cost_usd: null,
      created_at: '2026-07-12T09:59:58.000Z',
    },
    {
      run_id: 'run-live-2',
      agent: { id: 'ag-2', name: 'Hera', key: 'hera-reviewer', role: 'Reviewer' },
      ticket: { key: 'CHK-4', summary: 'Review cart', jira_url: 'https://acme.atlassian.net/browse/CHK-4' },
      workspace: { id: 'ws-2', name: 'Checkout' },
      status: 'running',
      attempt: 1,
      duration_ms: null,
      started_at: '2026-07-12T11:00:00.000Z',
      finished_at: null,
      cost_usd: null,
      created_at: '2026-07-12T10:59:58.000Z',
    },
    {
      run_id: 'run-live-3',
      agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
      ticket: { key: 'BRIG-11', summary: 'Next up', jira_url: 'https://acme.atlassian.net/browse/BRIG-11' },
      workspace: { id: 'ws-1', name: 'Acme' },
      status: 'queued',
      attempt: 1,
      duration_ms: null,
      started_at: null,
      finished_at: null,
      cost_usd: null,
      created_at: '2026-07-12T11:20:00.000Z',
    },
  ],
  total: 3,
};

/** Needs-attention list: one failed + one timed_out, newest finished first. */
export const sampleGlobalRunsAttention: GlobalRunsResponse = {
  items: [
    {
      run_id: 'run-att-1',
      agent: { id: 'ag-1', name: 'Implementer', key: 'implementer', role: null },
      ticket: { key: 'BRIG-8', summary: 'Broke the build', jira_url: 'https://acme.atlassian.net/browse/BRIG-8' },
      workspace: { id: 'ws-1', name: 'Acme' },
      status: 'failed',
      attempt: 2,
      duration_ms: 60000,
      started_at: '2026-07-12T08:00:00.000Z',
      finished_at: '2026-07-12T08:01:00.000Z',
      cost_usd: '0.5000',
      created_at: '2026-07-12T07:59:58.000Z',
    },
    {
      run_id: 'run-att-2',
      agent: { id: 'ag-2', name: 'Hera', key: 'hera-reviewer', role: 'Reviewer' },
      ticket: null,
      workspace: { id: 'ws-2', name: 'Checkout' },
      status: 'timed_out',
      attempt: 1,
      duration_ms: 2700000,
      started_at: '2026-07-12T06:00:00.000Z',
      finished_at: '2026-07-12T06:45:00.000Z',
      cost_usd: null,
      created_at: '2026-07-12T05:59:58.000Z',
    },
  ],
  total: 2,
};

export const sampleHomeWorkspaces: HomeWorkspacesResponse = {
  items: [
    {
      id: 'ws-1',
      name: 'Acme',
      project_key: 'BRIG',
      board_type: 'kanban',
      enabled: true,
      agent_count: 4,
      last_run: {
        run_id: 'run-live-1',
        status: 'running',
        started_at: '2026-07-12T10:00:00.000Z',
        finished_at: null,
        created_at: '2026-07-12T09:59:58.000Z',
      },
      attention_24h: 1,
    },
    {
      id: 'ws-2',
      name: 'Checkout',
      project_key: 'CHK',
      board_type: 'scrum',
      enabled: false,
      agent_count: 2,
      last_run: {
        run_id: 'run-old-1',
        status: 'succeeded',
        started_at: '2026-07-10T10:00:00.000Z',
        finished_at: '2026-07-10T10:05:00.000Z',
        created_at: '2026-07-10T09:59:58.000Z',
      },
      attention_24h: 0,
    },
    {
      id: 'ws-3',
      name: 'Fresh',
      project_key: 'FRS',
      board_type: null,
      enabled: true,
      agent_count: 0,
      last_run: null,
      attention_24h: 0,
    },
  ],
};


// --- feature 027: channel health (US4) ---

export const sampleChannelHealth = {
  status: 'healthy' as const,
  generated_at: '2026-07-21T17:20:00.000Z',
  window_ms: 900_000,
  failure_threshold: 3,
  last_successful_callback_at: '2026-07-21T17:04:12.345Z',
  channel_failures_in_window: 0,
  probe_failures_in_window: 0,
  deployment_guard: { ok: true, reason: null },
  affected_runs: [],
};

export const degradedChannelHealth = {
  ...sampleChannelHealth,
  status: 'degraded' as const,
  channel_failures_in_window: 4,
  probe_failures_in_window: 1,
  affected_runs: [
    {
      run_id: 'run-degraded-1',
      ticket_key: 'BRIG-42',
      last_event_at: '2026-07-21T17:18:03.000Z',
    },
  ],
};

export const defaultHandlers = [
  http.get('/api/workspaces', () =>
    HttpResponse.json<WorkspaceListResponse>(paginated([sampleWorkspace])),
  ),
  http.post('/api/workspaces/verify', () => HttpResponse.json(sampleVerify)),
  http.post('/api/workspaces', () => HttpResponse.json(sampleWorkspace, { status: 201 })),
  http.get('/api/workspaces/:id/statuses', () => HttpResponse.json(sampleStatuses)),
  http.put('/api/workspaces/:id/settings', () => HttpResponse.json(sampleWorkspace)),
  http.put('/api/workspaces/:id/jira-connection', () => HttpResponse.json(sampleWorkspace)),
  // Detail-эндпоинт (реш. 2026-07-15): шапка/настройки резолвят workspace по id.
  http.get('/api/workspaces/:id', () => HttpResponse.json(sampleWorkspace)),
  http.get('/api/agents', () => HttpResponse.json<AgentListResponse>(paginated([sampleAgent]))),
  http.post('/api/agents', () => HttpResponse.json(sampleAgent, { status: 201 })),
  http.put('/api/agents/:id', () => HttpResponse.json(sampleAgent)),
  http.post('/api/agents/:id/test-run', () => HttpResponse.json({ run_id: 'run-1' }, { status: 202 })),

  // executors CRUD (platform-scoped — global /api/executors)
  http.get('/api/executors', () =>
    HttpResponse.json<ExecutorListResponse>(paginated(sampleExecutors)),
  ),
  http.post('/api/executors', () => HttpResponse.json(sampleExecutors[0], { status: 201 })),
  http.put('/api/executors/:executorId', () => HttpResponse.json(sampleExecutors[0])),
  http.delete('/api/executors/:executorId', () => new HttpResponse(null, { status: 204 })),

  // Home dashboard (feature 017): atomic summary, workspace cards, and the
  // bounded global runs list (dispatched on the mandatory `status` filter).
  http.get('/api/home/summary', () => HttpResponse.json(sampleHomeSummary)),
  // feature 027: channel-health индикатор (healthy по умолчанию).
  http.get('/api/channel-health', () => HttpResponse.json(sampleChannelHealth)),
  http.get('/api/home/workspaces', () => HttpResponse.json(sampleHomeWorkspaces)),
  http.get('/api/runs', ({ request }) => {
    const status = new URL(request.url).searchParams.get('status') ?? '';
    return HttpResponse.json(
      status.includes('running') ? sampleGlobalRunsLive : sampleGlobalRunsAttention,
    );
  }),

  // runs table + cost + card + cancel/retry (US2/US3)
  http.get('/api/workspaces/:id/runs', () => HttpResponse.json(sampleRunList)),
  http.get('/api/workspaces/:id/runs/cost', () => HttpResponse.json(sampleRunCost)),
  http.get('/api/runs/:id', () => HttpResponse.json(sampleRunCard)),
  http.post('/api/runs/:id/cancel', () => HttpResponse.json({ ok: true, cancelled: true })),
  http.post('/api/workspaces/:id/runs/cancel-all', () =>
    HttpResponse.json({ ok: true, cancelled_count: 2 }),
  ),
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
