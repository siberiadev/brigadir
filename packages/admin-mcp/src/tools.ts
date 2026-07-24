/**
 * `brigadir-admin` tool handlers (feature 012, specs/012-admin-mcp/contracts/admin-tools.md).
 *
 * A THIN HTTP client of the dashboard admin API — zero DB access. Each handler
 * maps to ONE dashboard call, authenticated with the dashboard bearer from its
 * OWN config (never a tool argument, Principle V). `create_workspace` injects the
 * Jira bot email/token from config into the request body; the model never sees or
 * passes them.
 *
 * Error posture mirrors the callback MCP (packages/mcp-server): a 4xx surfaces to
 * the model as a tool error WITH the response body (it carries the lint's
 * path-qualified issues) and is NEVER retried; a 5xx/network error is retried with
 * bounded backoff, then surfaced. A 2xx is projected into the tool's declared
 * output shape and returned as `structuredContent` + a text duplicate in `content`.
 */

export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface AdminToolConfig {
  apiUrl: string;
  dashboardToken: string;
  jiraEmail: string;
  jiraApiToken: string;
  /**
   * Feature 030: optional token for a PRIVATE role-template repo. Sourced from
   * the server's OWN env (BRIGADIR_AGENT_INSTRUCTIONS_TOKEN), injected into
   * create_workspace / set_agent_instructions_source — NEVER a tool argument
   * (Principle V, same posture as the Jira credentials).
   */
  agentInstructionsToken?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
}

interface HttpResult {
  status: number;
  body: unknown;
}

type ResolvedCfg = Required<Pick<AdminToolConfig, 'fetchImpl' | 'maxRetries' | 'retryDelayMs'>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 100, 2000);
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * One HTTP call with bounded retries: 5xx/network ≤ maxRetries, 4xx never retried
 * (the body carries the path-qualified issues the model repairs from).
 */
async function requestWithRetry(
  url: string,
  init: { method: string; body?: unknown },
  bearer: string,
  cfg: ResolvedCfg,
): Promise<HttpResult> {
  let attempt = 0;
  for (;;) {
    let res: Response | undefined;
    let networkError: unknown;
    try {
      res = await cfg.fetchImpl(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      networkError = err;
    }

    const transient = networkError !== undefined || (res !== undefined && res.status >= 500);
    if (!transient) {
      return { status: res!.status, body: await safeJson(res!) };
    }

    attempt++;
    if (attempt > cfg.maxRetries) {
      if (networkError !== undefined) {
        return { status: 0, body: { ok: false, error: `network error: ${String(networkError)}` } };
      }
      return { status: res!.status, body: await safeJson(res!) };
    }
    await sleep(cfg.retryDelayMs(attempt));
  }
}

function ok(structured: Record<string, unknown>): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** A non-2xx (or a local guard failure): surface the body verbatim, no structuredContent. */
function toolError(body: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(body ?? {}) }], isError: true };
}

// --- response projections (backend row → the tool's strict output shape) ---

interface Paginated<T> {
  items?: T[];
  total?: number;
}

function projectWorkspaceSummary(w: Record<string, unknown>): Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    project_key: w.project_key,
    board_type: w.board_type ?? null,
    enabled: w.enabled,
  };
}

function projectExecutorSummary(e: Record<string, unknown>): Record<string, unknown> {
  const config = (e.config ?? {}) as Record<string, unknown>;
  const model = typeof config.model === 'string' ? config.model : null;
  return { name: e.name, type: e.type, model, enabled: e.enabled };
}

function projectAgentSummary(a: Record<string, unknown>): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    // feature 014: readable handle + function alongside the persona name.
    key: a.key,
    role: a.role ?? null,
    description: a.description ?? null,
    is_orchestrator: a.is_orchestrator,
    executor_id: a.executor_id,
    trigger_status: a.trigger_status ?? null,
    status_success: a.status_success,
    status_failure: a.status_failure,
    enabled: a.enabled,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

/**
 * Feature 031: split admin env rows into non-secret and secret maps, resolving
 * each `secret_from_env` against the MCP SERVER's own process env (a secret
 * value NEVER travels through the model). Returns an error string if a row is
 * malformed or a referenced env var is missing.
 */
function splitEnvRows(
  rows: unknown,
): { plain: Record<string, string>; secret: Record<string, string> } | { error: string } {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  if (rows === undefined) return { plain, secret };
  if (!Array.isArray(rows)) return { error: 'env must be an array of { key, value | secret_from_env }' };
  for (const raw of rows) {
    const r = asRecord(raw);
    const key = typeof r.key === 'string' ? r.key : '';
    if (!key) return { error: 'each env row needs a key' };
    const hasValue = typeof r.value === 'string';
    const fromEnv = typeof r.secret_from_env === 'string' ? r.secret_from_env : '';
    if (hasValue === !!fromEnv) {
      return { error: `env "${key}": provide exactly one of value | secret_from_env` };
    }
    if (hasValue) {
      plain[key] = r.value as string;
    } else {
      const resolved = process.env[fromEnv];
      if (resolved === undefined) {
        return { error: `env "${key}": secret_from_env "${fromEnv}" is not set in the MCP server environment` };
      }
      secret[key] = resolved;
    }
  }
  return { plain, secret };
}

export interface AdminToolHandlers {
  list_workspaces(args: unknown): Promise<ToolCallResult>;
  get_workspace(args: unknown): Promise<ToolCallResult>;
  get_board_statuses(args: unknown): Promise<ToolCallResult>;
  list_executors(args: unknown): Promise<ToolCallResult>;
  list_agents(args: unknown): Promise<ToolCallResult>;
  create_workspace(args: unknown): Promise<ToolCallResult>;
  generate_agents(args: unknown): Promise<ToolCallResult>;
  create_team(args: unknown): Promise<ToolCallResult>;
  create_agent(args: unknown): Promise<ToolCallResult>;
  update_agent(args: unknown): Promise<ToolCallResult>;
  set_agent_instructions_source(args: unknown): Promise<ToolCallResult>;
  set_env(args: unknown): Promise<ToolCallResult>;
}

export function createToolHandlers(config: AdminToolConfig): AdminToolHandlers {
  const cfg: ResolvedCfg = {
    fetchImpl: config.fetchImpl ?? fetch,
    maxRetries: config.maxRetries ?? 3,
    retryDelayMs: config.retryDelayMs ?? defaultRetryDelayMs,
  };
  const base = config.apiUrl.replace(/\/+$/, '');
  const call = (method: string, path: string, body?: unknown) =>
    requestWithRetry(`${base}${path}`, { method, body }, config.dashboardToken, cfg);

  /** A local guard failure (e.g. a missing required id) surfaced like a tool error. */
  function localError(message: string): ToolCallResult {
    return toolError({ ok: false, error: message });
  }

  function requireId(args: unknown, field: string): string | null {
    const value = asRecord(args)[field];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  return {
    async list_workspaces(): Promise<ToolCallResult> {
      const res = await call('GET', '/api/workspaces?page_size=100');
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const page = (res.body ?? {}) as Paginated<Record<string, unknown>>;
      const items = page.items ?? [];
      if ((page.total ?? items.length) > items.length) {
        console.error(
          `brigadir-admin: list_workspaces returned ${items.length} of ${page.total} workspaces (page_size=100 cap)`,
        );
      }
      return ok({ items: items.map(projectWorkspaceSummary) });
    },

    async get_workspace(args: unknown): Promise<ToolCallResult> {
      const id = requireId(args, 'workspace_id');
      if (!id) return localError('workspace_id is required');
      const res = await call('GET', `/api/workspaces/${encodeURIComponent(id)}`);
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      return ok(asRecord(res.body));
    },

    async get_board_statuses(args: unknown): Promise<ToolCallResult> {
      const id = requireId(args, 'workspace_id');
      if (!id) return localError('workspace_id is required');
      // `refresh=true` VERBATIM — the controller checks `refresh === 'true'`;
      // any other value silently serves the 5-minute cache (StatusesService TTL).
      const res = await call('GET', `/api/workspaces/${encodeURIComponent(id)}/statuses?refresh=true`);
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const statuses = (asRecord(res.body).statuses ?? []) as Record<string, unknown>[];
      return ok({
        statuses: statuses.map((s) => ({ name: s.name, category: s.statusCategory })),
      });
    },

    async list_executors(): Promise<ToolCallResult> {
      const res = await call('GET', '/api/executors?page_size=100');
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const items = ((res.body ?? {}) as Paginated<Record<string, unknown>>).items ?? [];
      return ok({ items: items.map(projectExecutorSummary) });
    },

    async list_agents(args: unknown): Promise<ToolCallResult> {
      const id = requireId(args, 'workspace_id');
      if (!id) return localError('workspace_id is required');
      const res = await call('GET', `/api/agents?workspace=${encodeURIComponent(id)}&page_size=100`);
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const items = ((res.body ?? {}) as Paginated<Record<string, unknown>>).items ?? [];
      return ok({ items: items.map(projectAgentSummary) });
    },

    async create_workspace(args: unknown): Promise<ToolCallResult> {
      const a = asRecord(args);
      // Build the body from NAMED fields only — the Jira email/token come from
      // config, never from args (a smuggled `jira_api_token` arg is ignored).
      // Feature 031: repo env — non-secret values ride the create body; secrets
      // (secret_from_env) are resolved from THIS server's env and applied after
      // creation (keyed by the repo id the backend assigns). Keyed by repo name.
      const repoSecretsByName: Record<string, Record<string, string>> = {};
      const repositories: Record<string, unknown>[] = [];
      if (Array.isArray(a.repositories)) {
        for (const raw of a.repositories as Record<string, unknown>[]) {
          const split = splitEnvRows(raw.env);
          if ('error' in split) return localError(split.error);
          const name = raw.name as string;
          if (Object.keys(split.secret).length > 0) repoSecretsByName[name] = split.secret;
          repositories.push({
            name: raw.name,
            git_url: raw.git_url,
            default_branch:
              typeof raw.default_branch === 'string' && raw.default_branch.length > 0 ? raw.default_branch : 'main',
            ...(Object.keys(split.plain).length > 0 ? { env: split.plain } : {}),
          });
        }
      }
      // Feature 030: pass the (non-secret) template-source override through; the
      // private-repo token comes from the server's OWN env, never from args.
      const ai = asRecord(a.agent_instructions);
      const agentInstructions =
        typeof ai.git_url === 'string' && ai.git_url.length > 0
          ? {
              git_url: ai.git_url,
              ...(typeof ai.git_ref === 'string' && ai.git_ref ? { git_ref: ai.git_ref } : {}),
              ...(typeof ai.subdir === 'string' && ai.subdir ? { subdir: ai.subdir } : {}),
            }
          : undefined;
      const body = {
        name: a.name,
        jira_site_url: a.jira_site_url,
        jira_email: config.jiraEmail,
        jira_api_token: config.jiraApiToken,
        expires_at: a.expires_at,
        board: a.board,
        repositories,
        ...(agentInstructions ? { agent_instructions: agentInstructions } : {}),
        ...(agentInstructions && config.agentInstructionsToken
          ? { agent_instructions_token: config.agentInstructionsToken }
          : {}),
      };
      const res = await call('POST', '/api/workspaces', body);
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const w = asRecord(res.body);

      // Feature 031: apply repo secret env, keyed by the repo id the backend
      // assigned (repos carry a stable id from creation). A secret whose repo
      // can't be resolved is surfaced rather than silently dropped.
      const createdRepos = (w.repositories ?? []) as Record<string, unknown>[];
      for (const [name, secret] of Object.entries(repoSecretsByName)) {
        const repoId = createdRepos.find((r) => r.name === name)?.id;
        if (typeof repoId !== 'string') {
          return localError(`workspace created, but repository "${name}" had no id to attach its secret env`);
        }
        const sres = await call('PUT', `/api/workspaces/${encodeURIComponent(String(w.id))}/env-secrets`, {
          scope: { repository_id: repoId },
          set: secret,
        });
        if (sres.status < 200 || sres.status >= 300) return toolError(sres.body);
      }

      return ok({
        workspace_id: w.id,
        project_key: w.project_key,
        board_type: w.board_type ?? null,
        // The backend creates workspaces PAUSED (feature 011); pin it so the
        // model never assumes a started workspace.
        enabled: false,
      });
    },

    async generate_agents(args: unknown): Promise<ToolCallResult> {
      const id = requireId(args, 'workspace_id');
      if (!id) return localError('workspace_id is required');
      const res = await call('POST', `/api/workspaces/${encodeURIComponent(id)}/generate-agents`);
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      return ok({ run_id: asRecord(res.body).run_id });
    },

    async create_team(args: unknown): Promise<ToolCallResult> {
      const id = requireId(args, 'workspace_id');
      if (!id) return localError('workspace_id is required');
      const agents = asRecord(args).agents;
      const res = await call('POST', `/api/workspaces/${encodeURIComponent(id)}/team`, { agents });
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const b = asRecord(res.body);
      return ok({ workspace_id: b.workspace_id, agents_created: b.agents_created });
    },

    async create_agent(args: unknown): Promise<ToolCallResult> {
      const res = await call('POST', '/api/agents', asRecord(args));
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const b = asRecord(res.body);
      return ok({ agent_id: b.id, name: b.name, key: b.key, is_orchestrator: b.is_orchestrator });
    },

    async update_agent(args: unknown): Promise<ToolCallResult> {
      const id = requireId(args, 'agent_id');
      if (!id) return localError('agent_id is required');
      // The path carries the id; the body is the agent write shape (agent_id
      // stripped — the backend schema is strict and does not accept it).
      const { agent_id: _agentId, ...bodyRest } = asRecord(args);
      const res = await call('PUT', `/api/agents/${encodeURIComponent(id)}`, bodyRest);
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const b = asRecord(res.body);
      return ok({ agent_id: b.id, name: b.name, key: b.key, is_orchestrator: b.is_orchestrator });
    },

    async set_agent_instructions_source(args: unknown): Promise<ToolCallResult> {
      const a = asRecord(args);
      const wsId =
        typeof a.workspace_id === 'string' && a.workspace_id.length > 0 ? a.workspace_id : null;

      // source: an object to set, or null to clear. Build from named fields only.
      let source: Record<string, unknown> | null = null;
      if (a.source !== null && a.source !== undefined) {
        const s = asRecord(a.source);
        if (typeof s.git_url !== 'string' || s.git_url.length === 0) {
          return localError('source.git_url is required (or pass source: null to clear)');
        }
        source = {
          git_url: s.git_url,
          ...(typeof s.git_ref === 'string' && s.git_ref ? { git_ref: s.git_ref } : {}),
          ...(typeof s.subdir === 'string' && s.subdir ? { subdir: s.subdir } : {}),
        };
      }
      // The private-repo token comes from config env ONLY, and only when setting
      // a source (never on clear); a smuggled token arg is ignored.
      const withToken = source !== null && config.agentInstructionsToken !== undefined;

      if (wsId) {
        const res = await call('PUT', `/api/workspaces/${encodeURIComponent(wsId)}/settings`, {
          agent_instructions: source,
          ...(withToken ? { agent_instructions_token: config.agentInstructionsToken } : {}),
        });
        if (res.status < 200 || res.status >= 300) return toolError(res.body);
        const w = asRecord(res.body);
        return ok({ level: 'workspace', source: w.agent_instructions ?? null });
      }

      const res = await call('PUT', '/api/agent-instructions-settings', {
        source,
        ...(withToken ? { token: config.agentInstructionsToken } : {}),
      });
      if (res.status < 200 || res.status >= 300) return toolError(res.body);
      const b = asRecord(res.body);
      return ok({ level: 'global', source: b.source ?? null });
    },

    async set_env(args: unknown): Promise<ToolCallResult> {
      const wsId = requireId(args, 'workspace_id');
      if (!wsId) return localError('workspace_id is required');
      const a = asRecord(args);
      const split = splitEnvRows(a.set);
      if ('error' in split) return localError(split.error);
      const del = Array.isArray(a.delete) ? (a.delete as unknown[]).filter((k): k is string => typeof k === 'string') : [];

      // Read the workspace once — resolves repo name→id and carries the current
      // plaintext env for a read-modify-write.
      const wsRes = await call('GET', `/api/workspaces/${encodeURIComponent(wsId)}`);
      if (wsRes.status < 200 || wsRes.status >= 300) return toolError(wsRes.body);
      const ws = asRecord(wsRes.body);
      const repos = (ws.repositories ?? []) as Record<string, unknown>[];

      // Resolve scope → the env-secrets scope + a plaintext applier.
      const scope = a.scope;
      let secretScope: Record<string, unknown> | 'workspace';
      let scopeLabel: string;
      let applyPlain: ((merged: Record<string, string>) => Promise<HttpResult>) | null;
      let currentPlain: Record<string, string>;

      if (scope === 'workspace') {
        secretScope = 'workspace';
        scopeLabel = 'workspace';
        currentPlain = (ws.env ?? {}) as Record<string, string>;
        applyPlain = (merged) =>
          call('PUT', `/api/workspaces/${encodeURIComponent(wsId)}/settings`, { env: merged });
      } else if (asRecord(scope).repository !== undefined) {
        const ref = String(asRecord(scope).repository);
        const repo = repos.find((r) => r.id === ref || r.name === ref);
        if (!repo || typeof repo.id !== 'string') return localError(`repository "${ref}" not found in workspace`);
        const repoId = repo.id;
        secretScope = { repository_id: repoId };
        scopeLabel = `repository ${repo.name as string}`;
        currentPlain = (repo.env ?? {}) as Record<string, string>;
        applyPlain = (merged) => {
          const nextRepos = repos.map((r) =>
            r.id === repoId
              ? { name: r.name, git_url: r.git_url, default_branch: r.default_branch, id: r.id, env: merged }
              : { name: r.name, git_url: r.git_url, default_branch: r.default_branch, id: r.id, env: r.env },
          );
          return call('PUT', `/api/workspaces/${encodeURIComponent(wsId)}/settings`, { repositories: nextRepos });
        };
      } else if (asRecord(scope).agent !== undefined) {
        const ref = String(asRecord(scope).agent);
        const agRes = await call('GET', `/api/agents?workspace=${encodeURIComponent(wsId)}&page_size=100`);
        if (agRes.status < 200 || agRes.status >= 300) return toolError(agRes.body);
        const agents = ((agRes.body ?? {}) as Paginated<Record<string, unknown>>).items ?? [];
        const agent = agents.find((ag) => ag.id === ref || ag.key === ref);
        if (!agent || typeof agent.id !== 'string') return localError(`agent "${ref}" not found in workspace`);
        secretScope = { agent_id: agent.id };
        scopeLabel = `agent ${agent.key as string}`;
        currentPlain = {};
        // Non-secret agent env lives in behavior.env and is best edited via
        // update_agent (which runs the full agent lint); set_env handles agent
        // SECRETS. A plaintext agent row here is a clear, actionable error.
        applyPlain = null;
      } else {
        return localError('scope must be "workspace" | { repository } | { agent }');
      }

      if (applyPlain === null && Object.keys(split.plain).length > 0) {
        return localError('non-secret agent env: set behavior.env via update_agent; set_env handles agent secrets');
      }

      // 1) Secrets (and secret-side deletes) through the write-only endpoint.
      if (Object.keys(split.secret).length > 0 || del.length > 0) {
        const sres = await call('PUT', `/api/workspaces/${encodeURIComponent(wsId)}/env-secrets`, {
          scope: secretScope,
          ...(Object.keys(split.secret).length > 0 ? { set: split.secret } : {}),
          ...(del.length > 0 ? { delete: del } : {}),
        });
        if (sres.status < 200 || sres.status >= 300) return toolError(sres.body);
      }

      // 2) Non-secret upserts + deletes through settings (read-modify-write).
      if (applyPlain && (Object.keys(split.plain).length > 0 || del.length > 0)) {
        const merged = { ...currentPlain, ...split.plain };
        for (const k of del) delete merged[k];
        const pres = await applyPlain(merged);
        if (pres.status < 200 || pres.status >= 300) return toolError(pres.body);
      }

      return ok({
        scope: scopeLabel,
        plain_keys: Object.keys(split.plain),
        secret_keys: Object.keys(split.secret),
        deleted: del,
      });
    },
  };
}
