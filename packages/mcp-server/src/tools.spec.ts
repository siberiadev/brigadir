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
});
