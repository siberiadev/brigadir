import type { RunCardEvent } from '@brigadir/contracts';
import { formatClockTime } from '../../utils/date';

/**
 * Pure event → view-model mapping for the run timeline. The API contract keeps
 * `payload` untyped (`z.unknown()`), so every shape decision lives here, on the
 * client, and must survive anything: the executor's stream parser truncates
 * `tool_call.input` (a JSON.stringify'd string) at 500 chars, so large inputs
 * arrive as UNPARSEABLE cut-off strings — never assume payload fields exist.
 *
 * Item template (agreed 2026-07-15): `time · icon · title` with the message /
 * command always visible in a grey block below — no expand/collapse.
 */

export type TimelineTypeKey =
  | 'log'
  | 'progress'
  | 'tool_call'
  | 'jira_action'
  | 'api_retry'
  | 'error'
  | 'unknown';

export interface TimelineItem {
  id: string;
  /** 'HH:MM:SS' local wall-clock label. */
  time: string;
  /** Full local date-time for the title tooltip. */
  timeTitle: string;
  /** Drives the icon + accent color. */
  typeKey: TimelineTypeKey;
  /** Tool name / stage / 'Progress' — for unknown types the raw event type. */
  title: string;
  /** The command or message, shown in full in a grey block; null → no block. */
  body: string | null;
  percent: number | null;
}

const KNOWN_TYPES = new Set(['log', 'progress', 'tool_call', 'jira_action', 'api_retry', 'error']);

/** The first of these input fields that holds a string becomes the body. */
const BODY_KEYS = ['command', 'file_path', 'query', 'message', 'summary', 'description', 'content'];

/** Server-side snippet cap (stream-parser `snippetMaxChars`) — at this length assume truncation. */
const SNIPPET_MAX_CHARS = 500;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function stringifyPretty(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `mcp__jira__report_progress` → `report_progress (jira)`; plain names pass through. */
export function prettifyToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[2]} (${m[1]})` : name;
}

type ParsedInput =
  | { kind: 'fields'; fields: Record<string, unknown> }
  | { kind: 'raw'; raw: string; truncated: boolean }
  | { kind: 'none' };

/**
 * tool_call.input arrives either as an object (mock executor) or as a
 * JSON.stringify'd string truncated at 500 chars (claude-cli path) — short
 * strings re-parse cleanly, long ones are cut mid-JSON and don't.
 */
function parseToolInput(input: unknown): ParsedInput {
  const rec = asRecord(input);
  if (rec) return { kind: 'fields', fields: rec };
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      const parsedRec = asRecord(parsed);
      if (parsedRec) return { kind: 'fields', fields: parsedRec };
    } catch {
      // fall through to raw
    }
    return { kind: 'raw', raw: input, truncated: input.length >= SNIPPET_MAX_CHARS };
  }
  return { kind: 'none' };
}

interface Presented {
  title: string;
  body: string | null;
  percent: number | null;
}

function presentToolCall(payload: unknown, rawType: string): Presented {
  const rec = asRecord(payload);
  const name = asString(rec?.name);
  const title = name ? prettifyToolName(name) : rawType;
  const input = parseToolInput(rec?.input);

  if (input.kind === 'raw') {
    return { title, body: input.truncated ? `${input.raw}…` : input.raw, percent: null };
  }

  const fields = input.kind === 'fields' ? input.fields : {};
  let body: string | null = null;
  for (const key of BODY_KEYS) {
    body = asString(fields[key]);
    if (body) break;
  }
  if (!body && Object.keys(fields).length > 0) body = stringifyPretty(fields);
  return { title, body, percent: null };
}

function presentProgress(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const stage = asString(rec.stage);
  return {
    title: stage ? capitalize(stage) : 'Progress',
    body: asString(rec.message),
    percent: typeof rec.percent === 'number' ? rec.percent : null,
  };
}

function presentLog(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const parts: string[] = [];
  const model = asString(rec.model);
  if (model) parts.push(model);
  if (Array.isArray(rec.tools)) parts.push(`${rec.tools.length} tools`);
  if (Array.isArray(rec.mcp_servers)) {
    const servers = rec.mcp_servers
      .map((s: unknown) => {
        const sr = asRecord(s);
        return sr ? `${String(sr.name ?? '?')} (${String(sr.status ?? '?')})` : stringifyPretty(s);
      })
      .join(', ');
    if (servers) parts.push(`mcp: ${servers}`);
  }
  return {
    title: 'Session started',
    body: parts.length ? parts.join(' · ') : null,
    percent: null,
  };
}

function presentJiraAction(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const parts: string[] = [];
  if (rec.commented === true) parts.push('commented');
  const transitionedTo = asString(rec.transitioned_to);
  if (transitionedTo) parts.push(`→ ${transitionedTo}`);
  return { title: 'Jira', body: parts.length ? parts.join(' · ') : null, percent: null };
}

function presentApiRetry(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const parts: string[] = [];
  const error = asString(rec.error);
  if (error) parts.push(error);
  if (typeof rec.attempt === 'number') parts.push(`attempt ${rec.attempt}`);
  if (typeof rec.retry_delay_ms === 'number') parts.push(`retry in ${rec.retry_delay_ms}ms`);
  return { title: 'API retry', body: parts.length ? parts.join(' · ') : null, percent: null };
}

function presentError(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const message = asString(rec.message) ?? asString(rec.error);
  const stack = asString(rec.stack);
  const body = message && stack ? `${message}\n${stack}` : message ?? stack;
  return { title: 'Error', body, percent: null };
}

function presentUnknown(payload: unknown, rawType: string): Presented {
  if (typeof payload === 'string' && payload.length > 0) {
    return { title: rawType, body: payload, percent: null };
  }
  const rec = asRecord(payload);
  if (rec && Object.keys(rec).length > 0) {
    return { title: rawType, body: stringifyPretty(rec), percent: null };
  }
  if (payload != null && rec == null) {
    return { title: rawType, body: stringifyPretty(payload), percent: null };
  }
  return { title: rawType, body: null, percent: null };
}

export function presentEvent(e: RunCardEvent): TimelineItem {
  let presented: Presented;
  switch (e.type) {
    case 'tool_call':
      presented = presentToolCall(e.payload, e.type);
      break;
    case 'progress':
      presented = presentProgress(e.payload);
      break;
    case 'log':
      presented = presentLog(e.payload);
      break;
    case 'jira_action':
      presented = presentJiraAction(e.payload);
      break;
    case 'api_retry':
      presented = presentApiRetry(e.payload);
      break;
    case 'error':
      presented = presentError(e.payload);
      break;
    default:
      presented = presentUnknown(e.payload, e.type);
  }
  return {
    id: e.id,
    time: formatClockTime(e.created_at),
    timeTitle: new Date(e.created_at).toLocaleString(),
    typeKey: KNOWN_TYPES.has(e.type) ? (e.type as TimelineTypeKey) : 'unknown',
    ...presented,
  };
}

/**
 * A report_progress tool_call is immediately followed by the progress event it
 * produced — same message twice in a row. Keep only the progress card (it also
 * carries stage/percent).
 */
function isReportProgressDuplicate(e: RunCardEvent, next: RunCardEvent): boolean {
  if (e.type !== 'tool_call' || next.type !== 'progress') return false;
  const name = asString(asRecord(e.payload)?.name);
  if (!name?.endsWith('report_progress')) return false;
  const input = parseToolInput(asRecord(e.payload)?.input);
  const callMessage = input.kind === 'fields' ? asString(input.fields.message) : null;
  const progressMessage = asString(asRecord(next.payload)?.message);
  return callMessage != null && callMessage === progressMessage;
}

export function presentEvents(events: RunCardEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const next = events[i + 1];
    if (next && isReportProgressDuplicate(events[i], next)) continue;
    items.push(presentEvent(events[i]));
  }
  return items;
}
