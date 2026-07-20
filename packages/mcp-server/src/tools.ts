import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { writeMarker } from './marker.js';
import { writeOutbox, removeOutbox } from './outbox.js';

const execFileAsync = promisify(execFile);

/**
 * The three callback tools (contracts/mcp-config.md "Tool → HTTP mapping").
 * Each handler POSTs to the callback HTTP API with the run token from its own
 * env (never argv), applies bounded retries on 5xx/network only (D9, never
 * 4xx), and on a 2xx of complete_task / blocking request_human writes the
 * completion marker (FR-013). Zero DB access — a thin HTTP client only.
 */

/** Header carrying observed worktree HEADs on complete_task (feature 024). */
const OBSERVED_HEADS_HEADER = 'x-brigadir-observed-heads';

/**
 * Observe each configured worktree's HEAD (feature 024, completion gate). The
 * tool server is the only system-owned process colocated with the worktrees at
 * completion time. A repo whose `rev-parse` fails is OMITTED — evidence is
 * observed, never fabricated. Returns the header VALUE (JSON map) or undefined
 * when nothing is configured/observable, so no header is attached.
 */
async function observeHeads(
  repoDirs: Record<string, string> | undefined,
  resolver: (dir: string) => Promise<string | null>,
): Promise<string | undefined> {
  if (!repoDirs || Object.keys(repoDirs).length === 0) return undefined;
  const observed: Record<string, string> = {};
  for (const [repo, dir] of Object.entries(repoDirs)) {
    const sha = await resolver(dir);
    if (sha) observed[repo] = sha;
  }
  return JSON.stringify(observed);
}

/** Default HEAD resolver: `git -C <dir> rev-parse HEAD`, null on any failure. */
async function defaultGitHeadResolver(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolHandlersConfig {
  callbackUrl: string;
  runId: string;
  runToken: string;
  markerPath: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  /** Max retries for network errors / fetch failures (separate from HTTP 5xx). */
  maxNetworkErrorRetries?: number;
  /** Backoff for network errors (separate from HTTP 5xx). */
  networkRetryDelayMs?: (attempt: number) => number;
  /** Per-attempt fetch timeout in milliseconds. */
  fetchTimeoutMs?: number;
  /** Feature 024: repo name → worktree dir; HEADs observed on complete_task. */
  repoDirs?: Record<string, string>;
  /** Feature 024: injectable HEAD resolver (defaults to `git rev-parse HEAD`). */
  gitHeadResolver?: (dir: string) => Promise<string | null>;
}

interface CallbackResponse {
  status: number;
  body: unknown;
}

interface RetryConfig {
  fetchImpl: typeof fetch;
  usesCustomFetch: boolean;
  maxRetries: number;
  retryDelayMs: (attempt: number) => number;
  maxNetworkErrorRetries: number;
  networkRetryDelayMs: (attempt: number) => number;
  fetchTimeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultHttpRetryDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 100, 2000);
}

function defaultNetworkRetryDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 100, 30000);
}

const sharedHttpAgent = new HttpAgent({ keepAlive: true });
const sharedHttpsAgent = new HttpsAgent({ keepAlive: true });

function pickAgent(url: string): HttpAgent | HttpsAgent | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:') return sharedHttpAgent;
    if (parsed.protocol === 'https:') return sharedHttpsAgent;
  } catch {
    // malformed URL — proceed without keep-alive agent
  }
  return undefined;
}

function logDiagnostic(
  context: { method: string; url: string },
  attempt: number,
  err: unknown,
  status?: number,
): void {
  const statusPart = status !== undefined ? ` status=${status}` : '';
  const errText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(
    `[brigadir-mcp] callback attempt ${attempt} failed: method=${context.method} url=${context.url}${statusPart} error=${errText}`,
  );
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
 * Core retry loop. Distinguishes network errors (fetch threw) from HTTP 5xx:
 * - 4xx returns immediately (D9).
 * - 5xx retries up to `maxRetries` using `retryDelayMs`.
 * - Network errors retry up to `maxNetworkErrorRetries` using `networkRetryDelayMs`
 *   with a 30 s ceiling, surviving multi-minute backend outages.
 * Every transient failure is logged to stderr with URL, attempt, status, and
 * error details.
 */
async function fetchWithRetry(
  url: string,
  makeRequest: (signal: AbortSignal) => Promise<Response>,
  cfg: RetryConfig,
  context: { method: string },
): Promise<CallbackResponse> {
  let networkErrorsSeen = 0;
  let serverErrorsSeen = 0;

  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), cfg.fetchTimeoutMs);
    let res: Response | undefined;
    let networkError: unknown;
    try {
      res = await makeRequest(controller.signal);
    } catch (err) {
      networkError = err;
    } finally {
      clearTimeout(timeout);
    }

    if (networkError !== undefined) {
      networkErrorsSeen++;
      logDiagnostic({ method: context.method, url }, networkErrorsSeen, networkError);
      if (networkErrorsSeen > cfg.maxNetworkErrorRetries) {
        return {
          status: 0,
          body: { ok: false, error: `network error: ${String(networkError)}` },
        };
      }
      await sleep(cfg.networkRetryDelayMs(networkErrorsSeen));
      continue;
    }

    // If no network error occurred, the request must have produced a response.
    if (res === undefined) {
      throw new Error('response unexpectedly undefined after a non-throwing fetch');
    }

    if (res.status >= 500) {
      serverErrorsSeen++;
      logDiagnostic({ method: context.method, url }, serverErrorsSeen, new Error('server error'), res.status);
      if (serverErrorsSeen > cfg.maxRetries) {
        return { status: res.status, body: await safeJson(res) };
      }
      await sleep(cfg.retryDelayMs(serverErrorsSeen));
      continue;
    }

    return { status: res.status, body: await safeJson(res) };
  }
}

/** POST with bounded retries: 5xx ≤ maxRetries, network ≤ maxNetworkErrorRetries, 4xx never retried (D9). */
async function postWithRetry(
  url: string,
  body: unknown,
  runToken: string,
  cfg: RetryConfig,
  extraHeaders: Record<string, string> = {},
): Promise<CallbackResponse> {
  const agent = cfg.usesCustomFetch ? undefined : pickAgent(url);
  return fetchWithRetry(
    url,
    (signal) =>
      cfg.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${runToken}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit),
    cfg,
    { method: 'POST' },
  );
}

/** GET with the same bounded-retry posture (feature 011 read tools). */
async function getWithRetry(
  url: string,
  runToken: string,
  cfg: RetryConfig,
): Promise<CallbackResponse> {
  const agent = cfg.usesCustomFetch ? undefined : pickAgent(url);
  return fetchWithRetry(
    url,
    (signal) =>
      cfg.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${runToken}` },
        signal,
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit),
    cfg,
    { method: 'GET' },
  );
}

function toResult(response: CallbackResponse): ToolCallResult {
  const isError = response.status < 200 || response.status >= 300;
  return {
    content: [{ type: 'text', text: JSON.stringify(response.body ?? {}) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createToolHandlers(config: ToolHandlersConfig): {
  report_progress: (args: unknown) => Promise<ToolCallResult>;
  request_human: (args: unknown) => Promise<ToolCallResult>;
  complete_task: (args: unknown) => Promise<ToolCallResult>;
  get_project_overview: (args: unknown) => Promise<ToolCallResult>;
  search_tickets: (args: unknown) => Promise<ToolCallResult>;
  get_ticket: (args: unknown) => Promise<ToolCallResult>;
} {
  const cfg: RetryConfig = {
    fetchImpl: config.fetchImpl ?? fetch,
    usesCustomFetch: config.fetchImpl !== undefined,
    maxRetries: config.maxRetries ?? 3,
    retryDelayMs: config.retryDelayMs ?? defaultHttpRetryDelayMs,
    maxNetworkErrorRetries: config.maxNetworkErrorRetries ?? 10,
    networkRetryDelayMs: config.networkRetryDelayMs ?? defaultNetworkRetryDelayMs,
    fetchTimeoutMs: config.fetchTimeoutMs ?? 10_000,
  };
  const gitHeadResolver = config.gitHeadResolver ?? defaultGitHeadResolver;
  const base = config.callbackUrl.replace(/\/+$/, '');

  return {
    async report_progress(args: unknown): Promise<ToolCallResult> {
      const response = await postWithRetry(
        `${base}/runs/${config.runId}/progress`,
        args,
        config.runToken,
        cfg,
      );
      return toResult(response);
    },

    async request_human(args: unknown): Promise<ToolCallResult> {
      const response = await postWithRetry(
        `${base}/runs/${config.runId}/human`,
        args,
        config.runToken,
        cfg,
      );
      if (response.status >= 200 && response.status < 300) {
        const body = response.body as { blocking?: boolean } | undefined;
        if (body?.blocking === true) {
          await writeMarker(config.markerPath);
        }
      }
      return toResult(response);
    },

    async complete_task(args: unknown): Promise<ToolCallResult> {
      // Feature 024: observe worktree HEADs and hand them to the backend gate.
      // Attached by the tool server itself — outside the tool's input schema,
      // so the agent cannot author or spoof it.
      const observedHeads = await observeHeads(config.repoDirs, gitHeadResolver);
      // Durable-finalize outbox (Phase 4, Problem 6): persist the report locally
      // BEFORE the POST, so a callback that never reaches the backend (the
      // incident's `fetch failed`) can still be reconciled by the worker.
      await writeOutbox(config.markerPath, config.runId, args);
      const response = await postWithRetry(
        `${base}/runs/${config.runId}/complete`,
        args,
        config.runToken,
        cfg,
        observedHeads !== undefined ? { [OBSERVED_HEADS_HEADER]: observedHeads } : {},
      );
      if (response.status >= 200 && response.status < 300) {
        await writeMarker(config.markerPath);
        // Callback confirmed — the durable fallback is no longer needed.
        await removeOutbox(config.markerPath, config.runId);
      }
      return toResult(response);
    },

    // --- feature 011: read-only Jira tools (contracts/jira-read-tools.md).
    // Reads never touch the completion marker; 4xx (403 out_of_scope, 404,
    // 422) surfaces verbatim to the model as a tool error.

    async get_project_overview(_args: unknown): Promise<ToolCallResult> {
      const response = await getWithRetry(
        `${base}/runs/${config.runId}/jira/overview`,
        config.runToken,
        cfg,
      );
      return toResult(response);
    },

    async search_tickets(args: unknown): Promise<ToolCallResult> {
      const response = await postWithRetry(
        `${base}/runs/${config.runId}/jira/search`,
        args ?? {},
        config.runToken,
        cfg,
      );
      return toResult(response);
    },

    async get_ticket(args: unknown): Promise<ToolCallResult> {
      const key = (args as { key?: unknown } | null)?.key;
      if (typeof key !== 'string' || key.length === 0) {
        return {
          content: [{ type: 'text', text: '{"ok":false,"error":"key is required"}' }],
          isError: true,
        };
      }
      const response = await getWithRetry(
        `${base}/runs/${config.runId}/jira/tickets/${encodeURIComponent(key)}`,
        config.runToken,
        cfg,
      );
      return toResult(response);
    },
  };
}
