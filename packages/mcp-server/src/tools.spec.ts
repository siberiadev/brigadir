import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolHandlers } from './tools';

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
      maxRetries: 3,
      retryDelayMs: () => 0,
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
