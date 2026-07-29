/**
 * Incremental NDJSON → event mapper (research D5/D13, data-model.md's event
 * table). One `ClaudeStreamParser` instance per run: `parseLine` is fed one
 * line of stdout at a time as it arrives (never buffers the whole stream),
 * and a bad/partial line is skipped — never throws, never aborts the run
 * (FR-014). Progress-event sampling state (cap N / min interval) lives on
 * the instance since it must persist across calls within one run.
 *
 * No `result.result`-text fallback parsing exists here: research D1's
 * residual uncertainty was resolved by a live prototype (CLI v2.1.207,
 * 2026-07-11) — the terminal `result` event carries `structured_output`
 * directly. Only that field is ever read.
 */

import { sanitizeToolInput } from './tool-input-sanitizer';

export type RunEventType = 'log' | 'tool_call' | 'progress' | 'api_retry' | 'tool_denied';

/**
 * Stable prefix of every bash-guard deny reason. Duplicated from
 * `packages/mcp-server/src/bash-guard-logic.ts` (BASH_GUARD_PREFIX) — no
 * cross-package import by design; both spec suites pin the literal so drift
 * fails tests.
 */
const BASH_GUARD_DENY_PREFIX = '[brigadir-bash-guard]';

/**
 * Bound on the pending tool_use map (feature-026 discipline: nothing
 * unbounded). Denials arrive on the very next `user` message, so 50 in-flight
 * calls is far beyond any real interleaving.
 */
const MAX_PENDING_TOOL_USES = 50;

/** tool_result content is a plain string or an array of text blocks — never throw on either. */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const b = block as Record<string, unknown>;
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('\n');
}

export interface RunEventOut {
  type: RunEventType;
  payload: Record<string, unknown>;
}

export interface TerminalResult {
  totalCostUsd?: number;
  usage?: unknown;
  structuredOutput?: unknown;
  isError?: boolean;
}

export type ParsedLine =
  | { kind: 'run_event'; event: RunEventOut }
  | { kind: 'external_ref'; sessionId: string }
  | { kind: 'rate_limit'; retryDelayMs?: number; attempt?: number }
  | { kind: 'terminal'; result: TerminalResult };

export interface StreamParserOptions {
  /** Max number of `progress` events persisted per run (bounded timeline, FR-011). */
  maxProgressEvents?: number;
  /** Minimum ms between persisted `progress` events (0 = count-only cap). */
  minProgressIntervalMs?: number;
  /** Injectable clock for deterministic sampling tests. */
  now?: () => number;
  /**
   * Secret scrubber applied to every retained tool_call string field before it
   * is persisted (feature 026, Constitution V). Defaults to identity so unit
   * tests stay deterministic; the executor injects `@brigadir/scrubber.scrub`.
   */
  scrub?: (s: string) => string;
}

export class ClaudeStreamParser {
  private readonly maxProgressEvents: number;
  private readonly minProgressIntervalMs: number;
  private readonly now: () => number;
  private readonly scrub: (s: string) => string;

  private progressCount = 0;
  private lastProgressAt: number | undefined;

  /**
   * tool_use id → {name, command} so a bash-guard denial (surfacing later in a
   * `user` tool_result) can name the denied command. Insertion-ordered, capped
   * at MAX_PENDING_TOOL_USES (oldest evicted); entries drop when their result
   * arrives.
   */
  private readonly pendingToolUses = new Map<string, { name: string; command?: string }>();

  constructor(options: StreamParserOptions = {}) {
    // feature 026: raised 20 → 100. Sampling still bounds ROW COUNT (an agent
    // can emit hundreds of text blocks); it no longer bounds message length —
    // human/assistant text is persisted in full (FR-003/FR-007).
    this.maxProgressEvents = options.maxProgressEvents ?? 100;
    this.minProgressIntervalMs = options.minProgressIntervalMs ?? 0;
    this.now = options.now ?? Date.now;
    this.scrub = options.scrub ?? ((s) => s);
  }

  /** Parse one NDJSON line. Malformed/partial JSON yields `[]`, never throws. */
  parseLine(line: string): ParsedLine[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }

    if (typeof event !== 'object' || event === null) return [];
    return this.mapEvent(event as Record<string, unknown>);
  }

  private mapEvent(e: Record<string, unknown>): ParsedLine[] {
    if (e.type === 'system' && e.subtype === 'init') {
      return this.mapInit(e);
    }
    if (e.type === 'system' && e.subtype === 'api_retry') {
      return this.mapApiRetry(e);
    }
    if (e.type === 'assistant') {
      return this.mapAssistant(e);
    }
    if (e.type === 'user') {
      return this.mapUser(e);
    }
    if (e.type === 'result') {
      return this.mapTerminal(e);
    }
    return [];
  }

  private mapInit(e: Record<string, unknown>): ParsedLine[] {
    const out: ParsedLine[] = [
      {
        kind: 'run_event',
        event: {
          type: 'log',
          payload: {
            session_id: e.session_id,
            model: e.model,
            tools: e.tools,
            mcp_servers: e.mcp_servers,
          },
        },
      },
    ];
    if (typeof e.session_id === 'string') {
      out.push({ kind: 'external_ref', sessionId: e.session_id });
    }
    return out;
  }

  private mapApiRetry(e: Record<string, unknown>): ParsedLine[] {
    // Only a genuine subscription rate-limit escalates to a distinct
    // outcome (D5); overloaded/server_error/etc are the CLI's own transient
    // retries — logged by the caller (if it chooses to), not persisted here,
    // and the run continues.
    if (e.error !== 'rate_limit') return [];

    const retryDelayMs = typeof e.retry_delay_ms === 'number' ? e.retry_delay_ms : undefined;
    const attempt = typeof e.attempt === 'number' ? e.attempt : undefined;

    return [
      {
        kind: 'run_event',
        event: {
          type: 'api_retry',
          payload: { error: e.error, retry_delay_ms: retryDelayMs, attempt },
        },
      },
      { kind: 'rate_limit', retryDelayMs, attempt },
    ];
  }

  private mapAssistant(e: Record<string, unknown>): ParsedLine[] {
    const message = e.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    const out: ParsedLine[] = [];

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === 'tool_use') {
        // feature 026: persist a STRUCTURED, per-field-sanitized input object
        // (never a stringified blob) so the UI can always decompose it. Every
        // retained string — including nested ones — passes the scrubber.
        const sanitized = sanitizeToolInput(String(b.name ?? ''), b.input ?? {}, this.scrub);
        this.rememberToolUse(b);
        out.push({
          kind: 'run_event',
          event: {
            type: 'tool_call',
            payload: { name: b.name, input: sanitized.input, truncated: sanitized.truncated },
          },
        });
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const sampled = this.sampleProgress(b.text);
        if (sampled) out.push(sampled);
      }
    }
    return out;
  }

  private mapTerminal(e: Record<string, unknown>): ParsedLine[] {
    return [
      {
        kind: 'terminal',
        result: {
          totalCostUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined,
          usage: e.usage,
          structuredOutput: e.structured_output,
          isError: typeof e.is_error === 'boolean' ? e.is_error : undefined,
        },
      },
    ];
  }

  private rememberToolUse(b: Record<string, unknown>): void {
    if (typeof b.id !== 'string') return;
    const input = b.input;
    const command =
      typeof input === 'object' &&
      input !== null &&
      typeof (input as Record<string, unknown>).command === 'string'
        ? ((input as Record<string, unknown>).command as string)
        : undefined;
    if (this.pendingToolUses.size >= MAX_PENDING_TOOL_USES) {
      const oldest = this.pendingToolUses.keys().next().value;
      if (oldest !== undefined) this.pendingToolUses.delete(oldest);
    }
    this.pendingToolUses.set(b.id, { name: String(b.name ?? ''), command });
  }

  /**
   * `user` messages carry tool_result blocks. Only bash-guard denials (their
   * text carries BASH_GUARD_DENY_PREFIX) become `tool_denied` run events —
   * everything else is dropped, as before this event type existed.
   */
  private mapUser(e: Record<string, unknown>): ParsedLine[] {
    const message = e.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    const out: ParsedLine[] = [];

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result') continue;

      const pending =
        typeof b.tool_use_id === 'string' ? this.pendingToolUses.get(b.tool_use_id) : undefined;
      if (typeof b.tool_use_id === 'string') this.pendingToolUses.delete(b.tool_use_id);

      const text = extractToolResultText(b.content);
      if (!text.includes(BASH_GUARD_DENY_PREFIX)) continue;

      const name = pending?.name ?? 'Bash';
      const sanitized = sanitizeToolInput(
        name,
        {
          name,
          reason: text,
          ...(pending?.command !== undefined ? { command: pending.command } : {}),
        },
        this.scrub,
      );
      out.push({
        kind: 'run_event',
        event: {
          type: 'tool_denied',
          payload: { ...sanitized.input, truncated: sanitized.truncated },
        },
      });
    }
    return out;
  }

  private sampleProgress(text: string): ParsedLine | undefined {
    if (this.progressCount >= this.maxProgressEvents) return undefined;

    const now = this.now();
    if (
      this.lastProgressAt !== undefined &&
      now - this.lastProgressAt < this.minProgressIntervalMs
    ) {
      return undefined;
    }

    this.progressCount += 1;
    this.lastProgressAt = now;
    // feature 026 (FR-003): assistant text is human-authored — persist it in
    // full, never truncated. Sampling above is the only bound (row count).
    return { kind: 'run_event', event: { type: 'progress', payload: { message: text } } };
  }
}
