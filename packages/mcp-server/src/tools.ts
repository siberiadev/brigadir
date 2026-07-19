import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeMarker } from './marker.js';

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
  /** Feature 024: repo name → worktree dir; HEADs observed on complete_task. */
  repoDirs?: Record<string, string>;
  /** Feature 024: injectable HEAD resolver (defaults to `git rev-parse HEAD`). */
  gitHeadResolver?: (dir: string) => Promise<string | null>;
}

interface CallbackResponse {
  status: number;
  body: unknown;
}

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

/** POST with bounded retries: 5xx/network ≤ maxRetries, 4xx never retried (D9). */
async function postWithRetry(
  url: string,
  body: unknown,
  runToken: string,
  cfg: Required<Pick<ToolHandlersConfig, 'fetchImpl' | 'maxRetries' | 'retryDelayMs'>>,
  extraHeaders: Record<string, string> = {},
): Promise<CallbackResponse> {
  let attempt = 0;
  for (;;) {
    let res: Response | undefined;
    let networkError: unknown;
    try {
      res = await cfg.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${runToken}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
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
        return {
          status: 0,
          body: { ok: false, error: `network error: ${String(networkError)}` },
        };
      }
      return { status: res!.status, body: await safeJson(res!) };
    }
    await sleep(cfg.retryDelayMs(attempt));
  }
}

/** GET with the same bounded-retry posture (feature 011 read tools). */
async function getWithRetry(
  url: string,
  runToken: string,
  cfg: Required<Pick<ToolHandlersConfig, 'fetchImpl' | 'maxRetries' | 'retryDelayMs'>>,
): Promise<CallbackResponse> {
  let attempt = 0;
  for (;;) {
    let res: Response | undefined;
    let networkError: unknown;
    try {
      res = await cfg.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${runToken}` },
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
        return {
          status: 0,
          body: { ok: false, error: `network error: ${String(networkError)}` },
        };
      }
      return { status: res!.status, body: await safeJson(res!) };
    }
    await sleep(cfg.retryDelayMs(attempt));
  }
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
  const cfg = {
    fetchImpl: config.fetchImpl ?? fetch,
    maxRetries: config.maxRetries ?? 3,
    retryDelayMs: config.retryDelayMs ?? defaultRetryDelayMs,
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
      const response = await postWithRetry(
        `${base}/runs/${config.runId}/complete`,
        args,
        config.runToken,
        cfg,
        observedHeads !== undefined ? { [OBSERVED_HEADS_HEADER]: observedHeads } : {},
      );
      if (response.status >= 200 && response.status < 300) {
        await writeMarker(config.markerPath);
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
