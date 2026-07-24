import { describe, it, expect } from 'vitest';
import { createToolHandlers, type AdminToolConfig } from './tools';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Captured {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function harness(
  responder: (captured: Captured) => Response | Promise<Response>,
  overrides: Partial<AdminToolConfig> = {},
) {
  const captured: Captured = {};
  const config: AdminToolConfig = {
    apiUrl: 'http://backend.test',
    dashboardToken: 'dash-secret',
    jiraEmail: 'bot@acme.com',
    jiraApiToken: 'jira-secret',
    retryDelayMs: () => 0,
    fetchImpl: async (url, init) => {
      captured.url = String(url);
      captured.method = init?.method;
      captured.headers = init?.headers as Record<string, string>;
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return responder(captured);
    },
    ...overrides,
  };
  return { handlers: createToolHandlers(config), captured };
}

describe('brigadir-admin tool handlers (feature 012)', () => {
  it('list_workspaces GETs the paginated endpoint and projects each row', async () => {
    const { handlers, captured } = harness(() =>
      jsonResponse(200, {
        items: [{ id: 'w1', name: 'A', project_key: 'BRIG', board_type: 'kanban', enabled: false, extra: 'x' }],
        page: 1,
        page_size: 100,
        total: 1,
      }),
    );
    const res = await handlers.list_workspaces({});
    expect(captured.url).toBe('http://backend.test/api/workspaces?page_size=100');
    expect(captured.method).toBe('GET');
    expect(captured.headers?.authorization).toBe('Bearer dash-secret');
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      items: [{ id: 'w1', name: 'A', project_key: 'BRIG', board_type: 'kanban', enabled: false }],
    });
    // text duplicates the structured content
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
  });

  it('get_board_statuses refreshes and maps statusCategory → category', async () => {
    const { handlers, captured } = harness(() =>
      jsonResponse(200, { statuses: [{ id: 's1', name: 'Ready for Dev', statusCategory: 'new' }] }),
    );
    const res = await handlers.get_board_statuses({ workspace_id: 'w1' });
    // refresh=true verbatim — the backend treats anything else (e.g. refresh=1)
    // as false and serves the 5-minute cache instead of the live board.
    expect(captured.url).toBe('http://backend.test/api/workspaces/w1/statuses?refresh=true');
    expect(res.structuredContent).toEqual({ statuses: [{ name: 'Ready for Dev', category: 'new' }] });
  });

  it('list_executors projects name/type/model/enabled (model from config.model)', async () => {
    const { handlers } = harness(() =>
      jsonResponse(200, {
        items: [
          { id: 'e1', name: 'claude', type: 'claude_cli', enabled: true, has_api_key: false, config: { model: 'claude-opus-4-8' } },
          { id: 'e2', name: 'mock', type: 'mock', enabled: true, has_api_key: false, config: {} },
        ],
        total: 2,
      }),
    );
    const res = await handlers.list_executors({});
    expect(res.structuredContent).toEqual({
      items: [
        { name: 'claude', type: 'claude_cli', model: 'claude-opus-4-8', enabled: true },
        { name: 'mock', type: 'mock', model: null, enabled: true },
      ],
    });
  });

  it('create_workspace injects the Jira creds from config and pins enabled=false', async () => {
    const { handlers, captured } = harness(() =>
      jsonResponse(201, { id: 'w9', project_key: 'BRIG', board_type: 'kanban', enabled: false }),
    );
    const res = await handlers.create_workspace({
      name: 'ws',
      jira_site_url: 'https://acme.atlassian.net',
      board: '42',
      expires_at: '2027-07-12T00:00:00.000Z',
      // a smuggled token in args must be IGNORED
      jira_api_token: 'attacker-supplied',
      jira_email: 'attacker@evil.com',
    });
    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('http://backend.test/api/workspaces');
    const body = captured.body as Record<string, unknown>;
    expect(body.jira_email).toBe('bot@acme.com');
    expect(body.jira_api_token).toBe('jira-secret');
    expect(body.repositories).toEqual([]);
    expect(res.structuredContent).toEqual({ workspace_id: 'w9', project_key: 'BRIG', board_type: 'kanban', enabled: false });
  });

  it('create_workspace defaults a repository default_branch to main', async () => {
    const { handlers, captured } = harness(() => jsonResponse(201, { id: 'w9', project_key: 'BRIG', board_type: 'scrum', enabled: false }));
    await handlers.create_workspace({
      name: 'ws',
      jira_site_url: 'https://acme.atlassian.net',
      board: '42',
      expires_at: '2027-07-12T00:00:00.000Z',
      repositories: [{ name: 'api', git_url: 'https://git/api.git' }],
    });
    const body = captured.body as { repositories: { default_branch: string }[] };
    expect(body.repositories[0].default_branch).toBe('main');
  });

  it('the dashboard bearer comes from config only — a token in args is never sent', async () => {
    const { handlers, captured } = harness(() => jsonResponse(200, { items: [], total: 0 }));
    await handlers.list_workspaces({ dashboard_token: 'attacker', authorization: 'Bearer attacker' } as never);
    expect(captured.headers?.authorization).toBe('Bearer dash-secret');
  });

  it('create_team posts { agents } to the team endpoint and returns the count', async () => {
    const { handlers, captured } = harness(() => jsonResponse(201, { workspace_id: 'w1', agents_created: 2 }));
    const agents = [{ name: 'Dev' }, { name: 'Rev' }];
    const res = await handlers.create_team({ workspace_id: 'w1', agents });
    expect(captured.url).toBe('http://backend.test/api/workspaces/w1/team');
    expect(captured.body).toEqual({ agents });
    expect(res.structuredContent).toEqual({ workspace_id: 'w1', agents_created: 2 });
  });

  it('a 4xx surfaces the response body as a tool error with NO retry', async () => {
    let calls = 0;
    const { handlers } = harness(() => {
      calls++;
      return jsonResponse(422, { error: { code: 'validation_failed', issues: [{ path: ['agents', 0, 'trigger_status'], code: 'status_absent' }] } });
    });
    const res = await handlers.create_team({ workspace_id: 'w1', agents: [{ name: 'X' }] });
    expect(calls).toBe(1);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(JSON.parse(res.content[0].text).error.issues[0].code).toBe('status_absent');
  });

  it('a 5xx then 200 succeeds after one retry', async () => {
    let calls = 0;
    const { handlers } = harness(() => {
      calls++;
      return calls === 1 ? jsonResponse(500, { ok: false }) : jsonResponse(200, { items: [], total: 0 });
    });
    const res = await handlers.list_workspaces({});
    expect(calls).toBe(2);
    expect(res.isError).toBeUndefined();
  });

  it('a network error retries to the bound then surfaces as a tool error', async () => {
    let calls = 0;
    const { handlers } = harness(
      () => {
        calls++;
        throw new Error('ECONNREFUSED');
      },
      { maxRetries: 3 },
    );
    const res = await handlers.list_executors({});
    expect(calls).toBe(4); // 1 + 3 retries
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/network error/);
  });

  it('update_agent puts to /api/agents/:id with agent_id stripped from the body', async () => {
    const { handlers, captured } = harness(() => jsonResponse(200, { id: 'a1', name: 'Dev', is_orchestrator: false }));
    const res = await handlers.update_agent({
      agent_id: 'a1',
      workspace_id: 'w1',
      name: 'Dev',
      instruction: 'do it',
      executor_id: 'e1',
      trigger_status: 'Ready for Dev',
      status_success: 'Done',
      status_failure: 'Blocked',
    });
    expect(captured.method).toBe('PUT');
    expect(captured.url).toBe('http://backend.test/api/agents/a1');
    expect((captured.body as Record<string, unknown>).agent_id).toBeUndefined();
    expect((captured.body as Record<string, unknown>).name).toBe('Dev');
    expect(res.structuredContent).toEqual({ agent_id: 'a1', name: 'Dev', is_orchestrator: false });
  });

  it('create_agent posts the write body and projects the id', async () => {
    const { handlers, captured } = harness(() => jsonResponse(201, { id: 'a2', name: 'Rev', is_orchestrator: false, warnings: [] }));
    const res = await handlers.create_agent({
      workspace_id: 'w1',
      name: 'Rev',
      instruction: 'review',
      executor_id: 'e1',
      trigger_status: 'Code Review',
      status_success: 'Done',
      status_failure: 'Blocked',
    });
    expect(captured.url).toBe('http://backend.test/api/agents');
    expect(res.structuredContent).toEqual({ agent_id: 'a2', name: 'Rev', is_orchestrator: false });
  });

  it('generate_agents posts and returns run_id; a 409 surfaces the code', async () => {
    const okRun = harness(() => jsonResponse(202, { run_id: 'r1' }));
    const res = await okRun.handlers.generate_agents({ workspace_id: 'w1' });
    expect(okRun.captured.url).toBe('http://backend.test/api/workspaces/w1/generate-agents');
    expect(res.structuredContent).toEqual({ run_id: 'r1' });

    const conflict = harness(() => jsonResponse(409, { error: { code: 'worker_agents_exist' } }));
    const res2 = await conflict.handlers.generate_agents({ workspace_id: 'w1' });
    expect(res2.isError).toBe(true);
    expect(JSON.parse(res2.content[0].text).error.code).toBe('worker_agents_exist');
  });

  it('a required id missing locally is a tool error without any HTTP call', async () => {
    let calls = 0;
    const { handlers } = harness(() => {
      calls++;
      return jsonResponse(200, {});
    });
    const res = await handlers.get_workspace({});
    expect(calls).toBe(0);
    expect(res.isError).toBe(true);
  });
});

describe('brigadir-admin agent role-template source (feature 030)', () => {
  const WS = '11111111-1111-4111-8111-111111111111';
  const CREATE_ARGS = {
    name: 'A',
    jira_site_url: 'https://x.atlassian.net',
    board: '42',
    expires_at: '2027-01-01T00:00:00.000Z',
  };

  it('create_workspace passes agent_instructions through and injects the token from config (not args)', async () => {
    const { handlers, captured } = harness(
      () => jsonResponse(201, { id: 'w1', project_key: 'BRIG', board_type: 'kanban' }),
      { agentInstructionsToken: 'ghp_from_config' },
    );
    const res = await handlers.create_workspace({
      ...CREATE_ARGS,
      agent_instructions: { git_url: 'https://github.com/acme/agents.git', subdir: 'roles' },
      // A smuggled token arg MUST be ignored (Principle V).
      agent_instructions_token: 'ghp_SMUGGLED',
    });
    const body = captured.body as Record<string, unknown>;
    expect(body.agent_instructions).toEqual({ git_url: 'https://github.com/acme/agents.git', subdir: 'roles' });
    expect(body.agent_instructions_token).toBe('ghp_from_config');
    expect(res.isError).toBeUndefined();
  });

  it('create_workspace omits the token when the server has none configured', async () => {
    const { handlers, captured } = harness(() =>
      jsonResponse(201, { id: 'w1', project_key: 'BRIG', board_type: 'kanban' }),
    );
    await handlers.create_workspace({
      ...CREATE_ARGS,
      agent_instructions: { git_url: 'https://github.com/acme/agents.git' },
    });
    const body = captured.body as Record<string, unknown>;
    expect(body.agent_instructions).toEqual({ git_url: 'https://github.com/acme/agents.git' });
    expect('agent_instructions_token' in body).toBe(false);
  });

  it('set_agent_instructions_source (workspace) PUTs the settings endpoint with the config token', async () => {
    const { handlers, captured } = harness(
      () => jsonResponse(200, { id: 'w1', agent_instructions: { git_url: 'https://github.com/acme/agents.git' } }),
      { agentInstructionsToken: 'ghp_from_config' },
    );
    const res = await handlers.set_agent_instructions_source({
      workspace_id: WS,
      source: { git_url: 'https://github.com/acme/agents.git' },
    });
    expect(captured.method).toBe('PUT');
    expect(captured.url).toBe(`http://backend.test/api/workspaces/${WS}/settings`);
    const body = captured.body as Record<string, unknown>;
    expect(body.agent_instructions).toEqual({ git_url: 'https://github.com/acme/agents.git' });
    expect(body.agent_instructions_token).toBe('ghp_from_config');
    expect(res.structuredContent).toEqual({ level: 'workspace', source: { git_url: 'https://github.com/acme/agents.git' } });
  });

  it('set_agent_instructions_source (global) PUTs the global endpoint; no token when unconfigured', async () => {
    const { handlers, captured } = harness(() =>
      jsonResponse(200, { source: { git_url: 'https://github.com/acme/agents.git' }, has_token: false }),
    );
    const res = await handlers.set_agent_instructions_source({
      source: { git_url: 'https://github.com/acme/agents.git' },
    });
    expect(captured.url).toBe('http://backend.test/api/agent-instructions-settings');
    const body = captured.body as Record<string, unknown>;
    expect(body.source).toEqual({ git_url: 'https://github.com/acme/agents.git' });
    expect('token' in body).toBe(false);
    expect(res.structuredContent).toEqual({ level: 'global', source: { git_url: 'https://github.com/acme/agents.git' } });
  });

  it('set_agent_instructions_source with source=null clears and never sends a token', async () => {
    const { handlers, captured } = harness(() => jsonResponse(200, { id: 'w1', agent_instructions: null }), {
      agentInstructionsToken: 'ghp_from_config',
    });
    const res = await handlers.set_agent_instructions_source({ workspace_id: WS, source: null });
    const body = captured.body as Record<string, unknown>;
    expect(body.agent_instructions).toBeNull();
    expect('agent_instructions_token' in body).toBe(false);
    expect(res.structuredContent).toEqual({ level: 'workspace', source: null });
  });
});

describe('brigadir-admin env variables (feature 031)', () => {
  interface Call { url: string; method?: string; body: unknown }

  /** Multi-call harness: scripts a response per call and records all of them. */
  function envHarness(script: (call: Call, i: number) => Response, overrides: Partial<AdminToolConfig> = {}) {
    const calls: Call[] = [];
    const config: AdminToolConfig = {
      apiUrl: 'http://backend.test',
      dashboardToken: 'dash-secret',
      jiraEmail: 'bot@acme.com',
      jiraApiToken: 'jira-secret',
      retryDelayMs: () => 0,
      fetchImpl: async (url, init) => {
        const call: Call = {
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        };
        calls.push(call);
        return script(call, calls.length - 1);
      },
      ...overrides,
    };
    return { handlers: createToolHandlers(config), calls };
  }

  it('create_workspace maps repo env: literal value inline, secret_from_env resolved and sealed after create', async () => {
    process.env.ADMIN_TEST_DB_URL = 'postgres://svc:sealed-secret@h/db';
    try {
      const { handlers, calls } = envHarness((call) => {
        if (call.method === 'POST') {
          return jsonResponse(201, {
            id: 'w9',
            project_key: 'BRIG',
            board_type: 'kanban',
            enabled: false,
            repositories: [{ id: 'repo-1', name: 'api' }],
          });
        }
        return jsonResponse(200, { env_secret_keys: { workspace: [], repos: { 'repo-1': ['DATABASE_URL'] }, agents: {} } });
      });
      const res = await handlers.create_workspace({
        name: 'ws',
        jira_site_url: 'https://acme.atlassian.net',
        board: '42',
        expires_at: '2027-07-12T00:00:00.000Z',
        repositories: [
          { name: 'api', git_url: 'https://git/api.git', env: [
            { key: 'PORT', value: '3100' },
            { key: 'DATABASE_URL', secret_from_env: 'ADMIN_TEST_DB_URL' },
          ] },
        ],
      });
      expect(res.isError).toBeUndefined();
      // POST carries the non-secret env inline...
      const post = calls.find((c) => c.method === 'POST')!;
      const repos = (post.body as { repositories: { env?: Record<string, string> }[] }).repositories;
      expect(repos[0].env).toEqual({ PORT: '3100' });
      // ...and the secret literal is NOT in the POST body at all.
      expect(JSON.stringify(post.body)).not.toContain('sealed-secret');
      // The secret goes to env-secrets keyed by repo id.
      const put = calls.find((c) => c.url.endsWith('/env-secrets'))!;
      expect(put.body).toEqual({ scope: { repository_id: 'repo-1' }, set: { DATABASE_URL: 'postgres://svc:sealed-secret@h/db' } });
    } finally {
      delete process.env.ADMIN_TEST_DB_URL;
    }
  });

  it('create_workspace errors (nothing sealed) when a secret_from_env var is missing', async () => {
    const { handlers, calls } = envHarness(() => jsonResponse(201, { id: 'w9', repositories: [] }));
    const res = await handlers.create_workspace({
      name: 'ws',
      jira_site_url: 'https://acme.atlassian.net',
      board: '42',
      expires_at: '2027-07-12T00:00:00.000Z',
      repositories: [{ name: 'api', git_url: 'https://git/api.git', env: [{ key: 'X', secret_from_env: 'DOES_NOT_EXIST_031' }] }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('DOES_NOT_EXIST_031');
    expect(calls.length).toBe(0); // failed before any HTTP call
  });

  it('set_env resolves a repository name→id and writes secret to env-secrets; literal never in the result', async () => {
    process.env.ADMIN_TEST_TOKEN = 'top-secret-value';
    try {
      const { handlers, calls } = envHarness((call) => {
        if (call.method === 'GET') {
          return jsonResponse(200, { id: 'w1', repositories: [{ id: 'repo-1', name: 'api', env: {} }], env: {} });
        }
        return jsonResponse(200, { env_secret_keys: { workspace: [], repos: { 'repo-1': ['API_TOKEN'] }, agents: {} } });
      });
      const res = await handlers.set_env({
        workspace_id: 'w1',
        scope: { repository: 'api' },
        set: [{ key: 'API_TOKEN', secret_from_env: 'ADMIN_TEST_TOKEN' }],
      });
      expect(res.isError).toBeUndefined();
      const put = calls.find((c) => c.url.endsWith('/env-secrets'))!;
      expect(put.body).toEqual({ scope: { repository_id: 'repo-1' }, set: { API_TOKEN: 'top-secret-value' } });
      // The result the model sees carries only key names, never the value.
      expect(res.content[0].text).not.toContain('top-secret-value');
      expect(res.structuredContent).toMatchObject({ secret_keys: ['API_TOKEN'] });
    } finally {
      delete process.env.ADMIN_TEST_TOKEN;
    }
  });

  it('set_env writes a non-secret workspace value via settings (read-modify-write)', async () => {
    const { handlers, calls } = envHarness((call) => {
      if (call.method === 'GET') return jsonResponse(200, { id: 'w1', repositories: [], env: { EXISTING: '1' } });
      return jsonResponse(200, { id: 'w1', env: { EXISTING: '1', NODE_ENV: 'test' } });
    });
    const res = await handlers.set_env({ workspace_id: 'w1', scope: 'workspace', set: [{ key: 'NODE_ENV', value: 'test' }] });
    expect(res.isError).toBeUndefined();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('/settings');
    expect((put.body as { env: Record<string, string> }).env).toEqual({ EXISTING: '1', NODE_ENV: 'test' });
  });

  it('set_env rejects an unknown repository', async () => {
    const { handlers } = envHarness(() => jsonResponse(200, { id: 'w1', repositories: [], env: {} }));
    const res = await handlers.set_env({ workspace_id: 'w1', scope: { repository: 'ghost' }, set: [{ key: 'X', value: '1' }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ghost');
  });
});
