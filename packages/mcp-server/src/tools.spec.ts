import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, access, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createToolHandlers, type ToolHandlersConfig } from './tools';
import { outboxFilePath } from './outbox';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('createToolHandlers (T095)', () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup() {
    tmpDir = await mkdtemp(join(tmpdir(), 'brigadir-mcp-tools-'));
    return join(tmpDir, 'run.marker');
  }

  it('200 on complete_task returns success and writes the marker', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(200, { ok: true, outcome: 'success' });
      },
    });

    const result = await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 'done', checks: [] });

    expect(calls).toBe(1);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
    expect(await exists(markerPath)).toBe(true);
    // Phase 4: a confirmed callback drops the durable outbox.
    expect(await exists(outboxFilePath(markerPath, 'run-1'))).toBe(false);
  });

  it('a network-error complete_task leaves a durable outbox with the report', async () => {
    const markerPath = await setup();
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      maxNetworkErrorRetries: 1,
      networkRetryDelayMs: () => 0,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const report = { schema_version: 1, outcome: 'success', summary: 'done', checks: [] };
    const result = await handlers.complete_task(report);

    // The callback never landed — but the report is durably persisted.
    expect(result.isError).toBe(true);
    expect(await exists(markerPath)).toBe(false);
    const outboxPath = outboxFilePath(markerPath, 'run-1');
    expect(await exists(outboxPath)).toBe(true);
    const persisted = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(persisted).toMatchObject({ runId: 'run-1', outcome: 'success', report });
    expect(typeof persisted.timestamp).toBe('string');
    expect(dirname(outboxPath)).toBe(join(tmpDir, '.brigadir-outbox'));
  });

  it('an outbox write failure never breaks completion', async () => {
    // Pre-create `.brigadir-outbox` as a FILE so the outbox mkdir fails — while
    // the marker (a sibling of that dir) still writes fine. Isolates the failure
    // to the outbox: the tool must still return the callback response.
    const markerPath = await setup();
    await writeFile(join(tmpDir, '.brigadir-outbox'), 'x');
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async () => jsonResponse(200, { ok: true, outcome: 'success' }),
    });

    const result = await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 'done', checks: [] });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
  });

  it('200 on non-blocking request_human does NOT write the marker', async () => {
    const markerPath = await setup();
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async () => jsonResponse(200, { ok: true, blocking: false }),
    });

    await handlers.request_human({ kind: 'question', title: 't', details: 'd', blocking: false });
    expect(await exists(markerPath)).toBe(false);
  });

  it('200 on blocking request_human writes the marker', async () => {
    const markerPath = await setup();
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async () => jsonResponse(200, { ok: true, blocking: true, mayFinishWithoutComplete: true }),
    });

    await handlers.request_human({ kind: 'blocker', title: 't', details: 'd', blocking: true });
    expect(await exists(markerPath)).toBe(true);
  });

  it('a 500 then 200 succeeds after one retry', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      retryDelayMs: () => 0,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jsonResponse(500, { ok: false });
        return jsonResponse(200, { ok: true });
      },
    });

    const result = await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(calls).toBe(2);
    expect(result.isError).toBeUndefined();
  });

  it('a 422 returns the error body with zero retries', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      retryDelayMs: () => 0,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(422, { ok: false, errors: [{ path: ['human_task'], message: 'required' }] });
      },
    });

    const result = await handlers.complete_task({ schema_version: 1, outcome: 'needs_human', summary: 's', checks: [] });
    expect(calls).toBe(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false });
    expect(await exists(markerPath)).toBe(false);
  });

  it('a network error retries up to the bound then surfaces as a tool error', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      maxNetworkErrorRetries: 3,
      networkRetryDelayMs: () => 0,
      fetchImpl: async () => {
        calls++;
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(calls).toBe(4); // 1 initial + 3 retries
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/network error/);
  });

  it('a network error retries up to the default network budget (10) then surfaces', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      networkRetryDelayMs: () => 0,
      fetchImpl: async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
    });

    const result = await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(calls).toBe(11); // 1 initial + 10 retries
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/network error/);
  });

  it('network error backoff increases exponentially up to a 30 s ceiling', async () => {
    const markerPath = await setup();
    const delays: number[] = [];
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      maxNetworkErrorRetries: 10,
      networkRetryDelayMs: (attempt) => {
        delays.push(Math.min(2 ** attempt * 100, 30000));
        return 0;
      },
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(delays).toHaveLength(10);
    expect(delays[0]).toBe(200);
    expect(delays[1]).toBe(400);
    expect(delays[2]).toBe(800);
    expect(delays[delays.length - 1]).toBe(30000);
  });

  it('a 4xx response is not retried', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(400, { ok: false, error: 'bad request' });
      },
    });

    const result = await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 's', checks: [] });
    expect(calls).toBe(1);
    expect(result.isError).toBe(true);
  });

  it('a 5xx uses the HTTP retry budget (maxRetries)', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      retryDelayMs: () => 0,
      fetchImpl: async () => {
        calls++;
        if (calls < 4) return jsonResponse(500, { ok: false });
        return jsonResponse(200, { ok: true });
      },
    });

    const result = await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(calls).toBe(4);
    expect(result.isError).toBeUndefined();
  });

  it('a hung fetch is aborted by the per-attempt timeout and retried', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchTimeoutMs: 10,
      maxNetworkErrorRetries: 1,
      networkRetryDelayMs: () => 0,
      fetchImpl: async (_url, init) => {
        calls++;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        }
        return jsonResponse(200, { ok: true });
      },
    });

    const result = await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(calls).toBe(2);
    expect(result.isError).toBeUndefined();
  });

  it('writes a diagnostic stderr line on each transient failure', async () => {
    const markerPath = await setup();
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      maxNetworkErrorRetries: 1,
      networkRetryDelayMs: () => 0,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const firstLine = stderrSpy.mock.calls[0][0] as string;
    expect(firstLine).toMatch(/callback attempt 1 failed/);
    expect(firstLine).toMatch(/url=http:\/\/callback.test\/api\/callbacks\/runs\/run-1\/progress/);
    expect(firstLine).toMatch(/error=TypeError: fetch failed/);
    stderrSpy.mockRestore();
  });

  it('sends Authorization: Bearer <runToken> on every call', async () => {
    const markerPath = await setup();
    let capturedAuth: string | null = null;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'super-secret-token',
      markerPath,
      fetchImpl: async (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>).authorization;
        return jsonResponse(200, { ok: true });
      },
    });

    await handlers.report_progress({ stage: 'x', message: 'y' });
    expect(capturedAuth).toBe('Bearer super-secret-token');
  });

  it('reads the run token from config only — never accepts it via tool arguments', async () => {
    const markerPath = await setup();
    let capturedAuth: string | null = null;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'server-side-token',
      markerPath,
      fetchImpl: async (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>).authorization;
        return jsonResponse(200, { ok: true });
      },
    });

    // A malicious/confused arg payload trying to smuggle a token is ignored —
    // the handler only ever sends the token from its own env-derived config.
    await handlers.report_progress({ stage: 'x', message: 'y', runToken: 'attacker-supplied' } as never);
    expect(capturedAuth).toBe('Bearer server-side-token');
  });

  // --- feature 024 (US3): completion gate — observed HEADs header ---

  it('complete_task attaches x-brigadir-observed-heads from the configured repo dirs', async () => {
    const markerPath = await setup();
    let capturedHeader: string | undefined;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      repoDirs: { product: '/wt/product', infra: '/wt/infra' },
      gitHeadResolver: async (dir) =>
        dir === '/wt/product' ? 'a'.repeat(40) : 'b'.repeat(40),
      fetchImpl: async (_url, init) => {
        capturedHeader = (init?.headers as Record<string, string>)['x-brigadir-observed-heads'];
        return jsonResponse(200, { ok: true, outcome: 'success' });
      },
    });

    await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 's', checks: [] });
    expect(JSON.parse(capturedHeader!)).toEqual({ product: 'a'.repeat(40), infra: 'b'.repeat(40) });
  });

  it('complete_task omits a repo whose rev-parse fails (evidence observed, never fabricated)', async () => {
    const markerPath = await setup();
    let capturedHeader: string | undefined;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      repoDirs: { product: '/wt/product', gone: '/wt/gone' },
      gitHeadResolver: async (dir) => (dir === '/wt/product' ? 'a'.repeat(40) : null),
      fetchImpl: async (_url, init) => {
        capturedHeader = (init?.headers as Record<string, string>)['x-brigadir-observed-heads'];
        return jsonResponse(200, { ok: true });
      },
    });

    await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 's', checks: [] });
    expect(JSON.parse(capturedHeader!)).toEqual({ product: 'a'.repeat(40) });
  });

  it('complete_task sends no observed-heads header when no repo dirs are configured', async () => {
    const markerPath = await setup();
    let headerPresent = true;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async (_url, init) => {
        headerPresent = 'x-brigadir-observed-heads' in (init?.headers as Record<string, string>);
        return jsonResponse(200, { ok: true });
      },
    });

    await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 's', checks: [] });
    expect(headerPresent).toBe(false);
  });

  // --- feature 011: read-only Jira tools ---

  it('get_project_overview GETs the overview endpoint and never touches the marker', async () => {
    const markerPath = await setup();
    let captured: { url?: string; method?: string } = {};
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), method: init?.method };
        return jsonResponse(200, { project_key: 'BRIG' });
      },
    });

    const result = await handlers.get_project_overview({});
    expect(captured.url).toBe('http://callback.test/api/callbacks/runs/run-1/jira/overview');
    expect(captured.method).toBe('GET');
    expect(result.isError).toBeUndefined();
    expect(await exists(markerPath)).toBe(false);
  });

  it('search_tickets POSTs the structured filters; a 4xx surfaces as a tool error (no retry)', async () => {
    const markerPath = await setup();
    let calls = 0;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async () => {
        calls++;
        return jsonResponse(422, { ok: false, errors: [{ path: ['jql'] }] });
      },
    });

    const result = await handlers.search_tickets({ jql: 'project = OTHER' });
    expect(result.isError).toBe(true);
    expect(calls).toBe(1);
  });

  it('get_ticket URL-encodes the key and rejects a missing key locally', async () => {
    const markerPath = await setup();
    let captured: string | undefined;
    const handlers = createToolHandlers({
      callbackUrl: 'http://callback.test/api/callbacks',
      runId: 'run-1',
      runToken: 'tok',
      markerPath,
      fetchImpl: async (url) => {
        captured = String(url);
        return jsonResponse(200, { key: 'BRIG-7' });
      },
    });

    await handlers.get_ticket({ key: 'BRIG-7' });
    expect(captured).toBe('http://callback.test/api/callbacks/runs/run-1/jira/tickets/BRIG-7');

    const missing = await handlers.get_ticket({});
    expect(missing.isError).toBe(true);
  });
});

/**
 * Contract tests over REAL HTTP with the REAL global fetch — no `fetchImpl`
 * injection. The 2026-07-19/20 incident shipped a fetch option (`dispatcher:
 * node:http.Agent`) that only ever executed on the production path, which the
 * mock-based suite above never exercises; every real tool call failed with
 * `TypeError: fetch failed`. These tests pin the production fetch path to a
 * live `node:http` server so a client-side transport regression can never be
 * mock-blind again.
 */
describe('createToolHandlers over real HTTP (no fetchImpl — production fetch path)', () => {
  interface SeenRequest {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }

  let tmpDir: string;
  let server: Server | undefined;
  let seen: SeenRequest[];
  /** Status/body per request, in order; the last entry repeats. */
  let responses: { status: number; body: unknown }[];

  afterEach(async () => {
    if (server) {
      // Undici's fetch keep-alives its sockets — drop them so close() resolves.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(
    responseQueue: { status: number; body: unknown }[],
  ): Promise<{ markerPath: string; config: ToolHandlersConfig; port: number }> {
    tmpDir = await mkdtemp(join(tmpdir(), 'brigadir-mcp-http-'));
    seen = [];
    responses = responseQueue;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const next = responses.length > 1 ? responses.shift()! : responses[0];
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server!.address();
    if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
    const port = address.port;
    return {
      markerPath: join(tmpDir, 'run.marker'),
      port,
      config: {
        callbackUrl: `http://127.0.0.1:${port}/api/callbacks`,
        runId: 'run-1',
        runToken: 'real-http-token',
        markerPath: join(tmpDir, 'run.marker'),
        retryDelayMs: () => 1,
        networkRetryDelayMs: () => 1,
        maxNetworkErrorRetries: 1,
      },
    };
  }

  it('report_progress delivers a Bearer-authed JSON POST and returns success on 200', async () => {
    const { config } = await setup([{ status: 200, body: { ok: true } }]);
    const handlers = createToolHandlers(config);

    const result = await handlers.report_progress({ stage: 'build', message: 'compiling' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/callbacks/runs/run-1/progress');
    expect(seen[0].headers.authorization).toBe('Bearer real-http-token');
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen[0].body)).toEqual({ stage: 'build', message: 'compiling' });
  });

  it('complete_task on 2xx writes the marker and removes the outbox file', async () => {
    const { config, markerPath } = await setup([{ status: 200, body: { ok: true, outcome: 'success' } }]);
    const handlers = createToolHandlers(config);

    const result = await handlers.complete_task({ schema_version: 1, outcome: 'success', summary: 'done', checks: [] });

    expect(result.isError).toBeUndefined();
    expect(await exists(markerPath)).toBe(true);
    expect(await exists(outboxFilePath(markerPath, 'run-1'))).toBe(false);
    expect(seen[0].url).toBe('/api/callbacks/runs/run-1/complete');
  });

  it('complete_task against a refused connection surfaces a network error and keeps the outbox', async () => {
    const { config, markerPath } = await setup([{ status: 200, body: { ok: true } }]);
    // Close the server so the port actively refuses connections.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const handlers = createToolHandlers(config);

    const report = { schema_version: 1, outcome: 'success', summary: 'done', checks: [] };
    const result = await handlers.complete_task(report);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/network error/);
    expect(await exists(markerPath)).toBe(false);
    const outboxPath = outboxFilePath(markerPath, 'run-1');
    expect(await exists(outboxPath)).toBe(true);
    expect(JSON.parse(await readFile(outboxPath, 'utf8'))).toMatchObject({ runId: 'run-1', report });
  });

  it('a 4xx returns immediately as a tool error with zero retries', async () => {
    const { config } = await setup([{ status: 422, body: { ok: false, errors: [{ path: ['human_task'] }] } }]);
    const handlers = createToolHandlers(config);

    const result = await handlers.complete_task({ schema_version: 1, outcome: 'needs_human', summary: 's', checks: [] });

    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('a 500 then 200 succeeds over real HTTP (retry works end to end)', async () => {
    const { config } = await setup([
      { status: 500, body: { ok: false } },
      { status: 200, body: { ok: true } },
    ]);
    const handlers = createToolHandlers(config);

    const result = await handlers.report_progress({ stage: 'x', message: 'y' });

    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(2);
  });
});
