import type { ErrorIssue } from '@brigadir/contracts';
import { getDashboardToken } from './token';

/**
 * The single typed API client for the dashboard. Injects the runtime bearer
 * token on every request and parses the shared path-qualified error shape
 * (contracts/dashboard-api.md) into a typed {@link ApiError} that the forms
 * consume to pin issues to fields.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: ErrorIssue[] = [],
    readonly warnings: ErrorIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The first issue whose path matches `field` (JSON-pointer-style array head). */
  issueFor(field: string): ErrorIssue | undefined {
    return this.issues.find((i) => i.path[0] === field);
  }
}

export interface ApiClientOptions {
  /** Overridable for tests; defaults to the runtime dashboard token. */
  getToken?: () => string;
  /** Base URL for requests; '' keeps calls same-origin (`/api/*`). */
  baseUrl?: string;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; issues?: ErrorIssue[]; warnings?: ErrorIssue[] };
}

export function createApiClient(options: ApiClientOptions = {}) {
  const getToken = options.getToken ?? getDashboardToken;
  const baseUrl = options.baseUrl ?? '';

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let envelope: ErrorEnvelope | undefined;
      try {
        envelope = (await res.json()) as ErrorEnvelope;
      } catch {
        envelope = undefined;
      }
      const err = envelope?.error;
      throw new ApiError(
        res.status,
        err?.code ?? 'request_failed',
        err?.message ?? (res.statusText || `HTTP ${res.status}`),
        err?.issues ?? [],
        err?.warnings ?? [],
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    request,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The app-wide singleton (tests build their own via {@link createApiClient}). */
export const apiClient: ApiClient = createApiClient();
