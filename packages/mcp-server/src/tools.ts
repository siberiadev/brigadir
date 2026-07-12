import { writeMarker } from './marker.js';

/**
 * The three callback tools (contracts/mcp-config.md "Tool → HTTP mapping").
 * Each handler POSTs to the callback HTTP API with the run token from its own
 * env (never argv), applies bounded retries on 5xx/network only (D9, never
 * 4xx), and on a 2xx of complete_task / blocking request_human writes the
 * completion marker (FR-013). Zero DB access — a thin HTTP client only.
 */

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
} {
  const cfg = {
    fetchImpl: config.fetchImpl ?? fetch,
    maxRetries: config.maxRetries ?? 3,
    retryDelayMs: config.retryDelayMs ?? defaultRetryDelayMs,
  };
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
      const response = await postWithRetry(
        `${base}/runs/${config.runId}/complete`,
        args,
        config.runToken,
        cfg,
      );
      if (response.status >= 200 && response.status < 300) {
        await writeMarker(config.markerPath);
      }
      return toResult(response);
    },
  };
}
