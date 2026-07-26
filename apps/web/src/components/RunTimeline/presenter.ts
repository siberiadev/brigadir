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
  // feature 026: durable-finalization safety-net events.
  | 'undelivered_report'
  | 'channel_down'
  // feature 027: доставка callback'а исчерпала ретраи (breadcrumb → run_events).
  | 'channel_failure'
  | 'unknown';

export type BodyFormat = 'markdown' | 'mono' | 'kv';

export type IconKey = TimelineTypeKey | 'report_progress' | 'request_human' | 'complete_task';

export interface TimelineTag {
  label: string;
  tone?: 'info' | 'success' | 'warning';
}

export interface TimelineItem {
  id: string;
  /** 'HH:MM:SS' local wall-clock label. */
  time: string;
  /** Full local date-time for the title tooltip. */
  timeTitle: string;
  /** Drives the accent color. */
  typeKey: TimelineTypeKey;
  /** Tool name / stage / 'Progress' — for unknown types the raw event type. */
  title: string;
  /** The command or message, shown in full in a grey block; null → no block. */
  body: string | null;
  percent: number | null;
  /** True for mcp__brigadir__* orchestrator callbacks (feature 026, set from US2). */
  orchestrator: boolean;
  /** Icon lookup — includes the orchestrator glyphs; defaults to `typeKey`. */
  iconKey: IconKey;
  /** Chips shown next to the title (kind/blocking/checks…); empty when none. */
  tags: TimelineTag[];
  /** How the body block should render; null when there is no body. */
  bodyFormat: BodyFormat | null;
  /** Key/value rows when `bodyFormat === 'kv'`; otherwise null. */
  kv: { key: string; value: string }[] | null;
  /** Legacy executor stored a truncated `input` string → show a note. */
  legacyTruncated: boolean;
  /** New-shape `payload.truncated` → a machine field was capped. */
  fieldTruncated: boolean;
}

const KNOWN_TYPES = new Set([
  'log',
  'progress',
  'tool_call',
  'jira_action',
  'api_retry',
  'error',
  'undelivered_report',
  'channel_down',
  'channel_failure',
]);

/**
 * The first of these input fields that holds a string becomes the body, in this
 * priority order. `message`/`details`/`summary` render as Markdown (FR-010);
 * everything else renders monospace (FR-011).
 */
const BODY_KEYS = ['command', 'message', 'details', 'summary', 'file_path', 'query', 'description', 'content'];
const MARKDOWN_BODY_KEYS = new Set(['message', 'details', 'summary']);

/** Legacy string inputs were `JSON.stringify`'d then cut at 500 — assume truncation at this length. */
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

/** The three brigadir callbacks — the agent's only voice to the orchestrator. */
type BrigadirKind = 'report_progress' | 'request_human' | 'complete_task';
const BRIGADIR_RE = /^mcp__brigadir__(report_progress|request_human|complete_task)$/;

function brigadirKind(name: string | null): BrigadirKind | null {
  const m = name ? BRIGADIR_RE.exec(name) : null;
  return m ? (m[1] as BrigadirKind) : null;
}

/** Fallback row title when a brigadir call's structured input is unavailable (legacy rows). */
function orchestratorFallbackTitle(kind: BrigadirKind): string {
  return kind === 'complete_task' ? 'Complete' : `${kind} → Brigadir`;
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
  bodyFormat?: BodyFormat | null;
  tags?: TimelineTag[];
  orchestrator?: boolean;
  iconKey?: IconKey;
  kv?: { key: string; value: string }[] | null;
  legacyTruncated?: boolean;
  fieldTruncated?: boolean;
}

/** Typed cards for the three brigadir callbacks (FR-008/009/013). */
function presentBrigadirCall(
  kind: BrigadirKind,
  fields: Record<string, unknown>,
  fieldTruncated: boolean,
): Presented {
  const base = { percent: null, orchestrator: true, iconKey: kind, fieldTruncated } as const;

  if (kind === 'request_human') {
    const humanKind = asString(fields.kind);
    const blocking = fields.blocking !== false; // schema default is true
    const tags: TimelineTag[] = [];
    if (humanKind) tags.push({ label: humanKind, tone: 'info' });
    tags.push(blocking ? { label: 'blocking', tone: 'warning' } : { label: 'non-blocking' });
    return {
      ...base,
      title: asString(fields.title) ?? orchestratorFallbackTitle(kind),
      tags,
      body: asString(fields.details),
      bodyFormat: 'markdown',
    };
  }

  if (kind === 'complete_task') {
    const outcome = asString(fields.outcome) ?? 'done';
    const checkCount = Array.isArray(fields.checks) ? fields.checks.length : 0;
    return {
      ...base,
      title: `Complete · ${outcome}`,
      tags: [{ label: `${checkCount} ${checkCount === 1 ? 'check' : 'checks'}`, tone: 'info' }],
      body: asString(fields.summary),
      bodyFormat: 'markdown',
    };
  }

  // report_progress — usually deduped against its progress event; when it isn't
  // (message differs), render the arrow-form card.
  return {
    ...base,
    title: `${kind} → Brigadir`,
    tags: [],
    body: asString(fields.message),
    bodyFormat: 'markdown',
  };
}

function presentToolCall(payload: unknown, rawType: string): Presented {
  const rec = asRecord(payload);
  const name = asString(rec?.name);
  const fieldTruncated = rec?.truncated === true;
  const kind = brigadirKind(name);
  const input = parseToolInput(rec?.input);

  // Legacy: `input` was a JSON.stringify string, possibly cut at 500 chars.
  // Render as-is (monospace); never repair broken JSON (FR-016). Keep the
  // orchestrator affordance from the name even when the payload is unusable.
  if (input.kind === 'raw') {
    return {
      title: kind ? orchestratorFallbackTitle(kind) : name ? prettifyToolName(name) : rawType,
      orchestrator: kind != null,
      iconKey: kind ?? undefined,
      body: input.truncated ? `${input.raw}…` : input.raw,
      percent: null,
      bodyFormat: 'mono',
      legacyTruncated: input.truncated,
      fieldTruncated,
    };
  }

  const fields = input.kind === 'fields' ? input.fields : {};
  if (kind) return presentBrigadirCall(kind, fields, fieldTruncated);

  const title = name ? prettifyToolName(name) : rawType;
  let body: string | null = null;
  let matchedKey: string | null = null;
  for (const key of BODY_KEYS) {
    const value = asString(fields[key]);
    if (value) {
      body = value;
      matchedKey = key;
      break;
    }
  }
  if (body) {
    const bodyFormat: BodyFormat = matchedKey && MARKDOWN_BODY_KEYS.has(matchedKey) ? 'markdown' : 'mono';
    return { title, body, percent: null, bodyFormat, fieldTruncated };
  }
  // No primary text field → a compact key/value list, never a JSON dump (FR-012).
  if (Object.keys(fields).length > 0) {
    const kv = Object.entries(fields).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : stringifyPretty(value),
    }));
    return { title, body: null, percent: null, bodyFormat: 'kv', kv, fieldTruncated };
  }
  return { title, body: null, percent: null, bodyFormat: null, fieldTruncated };
}

function presentProgress(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const stage = asString(rec.stage);
  return {
    title: stage ? capitalize(stage) : 'Progress',
    body: asString(rec.message),
    percent: typeof rec.percent === 'number' ? rec.percent : null,
    bodyFormat: 'markdown',
  };
}

function presentLog(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  // Feature 020 (FR-015): the repo-scoping decision event carries a composed
  // one-liner — surface it verbatim so an operator can tell "scoped on
  // purpose" from "scoping misfired" without reading raw payloads.
  const message = asString(rec.message);
  if (rec.source === 'repo-scoping' && message) {
    return { title: 'Repository scoping', body: message, percent: null };
  }
  // Feature 032: where each repository started, and whether a dependent was
  // released early. Both are kv/markdown bodies with decision chips — never a
  // JSON dump of the payload (feature-026 rules).
  if (rec.source === 'start-ref') return presentStartRef(rec, message);
  if (rec.source === 'dependency-release') return presentEarlyRelease(rec, message);
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

/** Human labels + chip tone for each start-ref decision (feature 023/024/032). */
const START_REF_DECISIONS: Record<string, { label: string; tone?: TimelineTag['tone'] }> = {
  report_confirmed: { label: 'continues own branch' },
  default_branch: { label: 'default branch' },
  inherited_from_blocker: { label: 'inherited from blocker', tone: 'info' },
  merged_blockers: { label: 'merged blockers', tone: 'info' },
  blocker_branch_merged: { label: 'blocker merged' },
  blocker_no_artifact: { label: 'blocker branch missing', tone: 'warning' },
  blocker_artifacts_unmounted: { label: 'repository not mounted', tone: 'warning' },
};

/**
 * Feature 032: the per-repository start decision. The composed `message` is the
 * body (a sentence a person can read); the machine facts — SHA, branch,
 * blockers — go in the kv list. The decision itself is a chip, so scanning a
 * timeline for "which repo did NOT get its blocker's work" is a glance.
 */
function presentStartRef(rec: Record<string, unknown>, message: string | null): Presented {
  const decision = asString(rec.decision) ?? '';
  const known = START_REF_DECISIONS[decision];
  const repo = asString(rec.repo);
  const tags: TimelineTag[] = [];
  if (known) tags.push({ label: known.label, tone: known.tone });
  else if (decision) tags.push({ label: decision });

  const kv: { key: string; value: string }[] = [];
  const continueBranch = asString(rec.continueBranch);
  if (continueBranch) kv.push({ key: 'branch', value: continueBranch });
  const merged = Array.isArray(rec.mergedBranches) ? rec.mergedBranches.map(String) : [];
  if (merged.length > 0) kv.push({ key: 'merged', value: merged.join(', ') });
  const blockers = Array.isArray(rec.blockers) ? rec.blockers : [];
  if (blockers.length > 0) {
    kv.push({
      key: 'blockers',
      value: blockers
        .map((b) => {
          const br = asRecord(b);
          if (!br) return stringifyPretty(b);
          const branch = asString(br.branch);
          return branch ? `${String(br.key)} (${branch})` : String(br.key);
        })
        .join(', '),
    });
  }
  const startSha = asString(rec.startSha);
  if (startSha) kv.push({ key: 'start commit', value: startSha.slice(0, 12) });
  const unmatched = Array.isArray(rec.unmatchedReportedRepos)
    ? rec.unmatchedReportedRepos.map(String)
    : [];
  if (unmatched.length > 0) kv.push({ key: 'unmatched reports', value: unmatched.join(', ') });

  return {
    title: repo ? `Start point · ${repo}` : 'Start point',
    body: message,
    percent: null,
    bodyFormat: message ? 'markdown' : kv.length > 0 ? 'kv' : null,
    // The kv list rides along with the sentence: both are useful, and neither
    // is a raw payload dump.
    kv: kv.length > 0 ? kv : null,
    tags,
  };
}

/**
 * Feature 032 (FR-015): this run started before its blocker was done, because
 * the blocker reached the workspace's configured release status.
 */
function presentEarlyRelease(rec: Record<string, unknown>, message: string | null): Presented {
  const matched = asString(rec.matched_status);
  const blockers = Array.isArray(rec.blockers) ? rec.blockers : [];
  const kv: { key: string; value: string }[] = [];
  if (matched) kv.push({ key: 'released at status', value: matched });
  if (blockers.length > 0) {
    kv.push({
      key: 'blockers',
      value: blockers
        .map((b) => {
          const br = asRecord(b);
          if (!br) return stringifyPretty(b);
          const status = asString(br.status);
          return status ? `${String(br.key)} (${status})` : String(br.key);
        })
        .join(', '),
    });
  }
  return {
    title: 'Released early',
    body: message,
    percent: null,
    bodyFormat: message ? 'markdown' : 'kv',
    kv: kv.length > 0 ? kv : null,
    tags: [{ label: 'early release', tone: 'info' }],
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

/**
 * feature 026: a verdict rescued from the outbox on a run whose status must
 * not change (cancelled/superseded). Surfaces the outcome + summary so the
 * operator sees nothing was silently lost.
 */
function presentUndeliveredReport(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const report = asRecord(rec.report) ?? {};
  const outcome = asString(report.outcome);
  const summary = asString(report.summary);
  const runStatus = asString(rec.run_status);
  const parts: string[] = [];
  if (outcome) parts.push(`outcome: ${outcome}`);
  if (runStatus) parts.push(`run status: ${runStatus}`);
  const head = parts.join(' · ');
  const body = summary ? (head ? `${head}\n${summary}` : summary) : head || null;
  return { title: 'Undelivered report', body, percent: null };
}

/** feature 026: a pre-flight probe found the callback channel down; the run was held, not spawned. */
function presentChannelDown(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const parts: string[] = [];
  const url = asString(rec.probe_url);
  if (url) parts.push(url);
  if (typeof rec.consecutive === 'number') parts.push(`consecutive failures: ${rec.consecutive}`);
  if (typeof rec.retry_in_ms === 'number') parts.push(`retry in ${rec.retry_in_ms}ms`);
  return { title: 'Channel unavailable', body: parts.length ? parts.join(' · ') : null, percent: null };
}

/**
 * feature 027: доставка callback'а исчерпала ретраи — tool-сервер оставил
 * breadcrumb, worker перелил его в run_events. Компактный key/value: когда,
 * какая тулза, сколько попыток, последняя ошибка, цель. `occurred_at` — момент
 * отказа доставки (created_at строки — момент ingestion'а, может отставать).
 */
function presentChannelFailure(payload: unknown): Presented {
  const rec = asRecord(payload) ?? {};
  const error = asRecord(rec.error) ?? {};
  const kv: { key: string; value: string }[] = [];
  const occurredAt = asString(rec.occurred_at);
  if (occurredAt) kv.push({ key: 'when', value: new Date(occurredAt).toLocaleString() });
  const tool = asString(rec.tool);
  if (tool) kv.push({ key: 'tool', value: tool });
  if (typeof rec.attempts === 'number') kv.push({ key: 'attempts', value: String(rec.attempts) });
  const errName = asString(error.name);
  const errMessage = asString(error.message);
  if (errName || errMessage) {
    kv.push({ key: 'error', value: [errName, errMessage].filter(Boolean).join(': ') });
  }
  if (typeof rec.status === 'number') kv.push({ key: 'HTTP', value: String(rec.status) });
  const target = asString(rec.target);
  if (target) kv.push({ key: 'target', value: target });

  const kind = asString(rec.kind);
  const tags: TimelineTag[] = kind ? [{ label: kind, tone: 'warning' }] : [];
  return {
    title: 'Callback channel failure',
    body: null,
    bodyFormat: kv.length ? 'kv' : null,
    kv: kv.length ? kv : null,
    tags,
    percent: null,
  };
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
    case 'undelivered_report':
      presented = presentUndeliveredReport(e.payload);
      break;
    case 'channel_down':
      presented = presentChannelDown(e.payload);
      break;
    case 'channel_failure':
      presented = presentChannelFailure(e.payload);
      break;
    default:
      presented = presentUnknown(e.payload, e.type);
  }
  const typeKey: TimelineTypeKey = KNOWN_TYPES.has(e.type) ? (e.type as TimelineTypeKey) : 'unknown';
  return {
    id: e.id,
    time: formatClockTime(e.created_at),
    timeTitle: new Date(e.created_at).toLocaleString(),
    typeKey,
    title: presented.title,
    body: presented.body,
    percent: presented.percent,
    orchestrator: presented.orchestrator ?? false,
    iconKey: presented.iconKey ?? typeKey,
    tags: presented.tags ?? [],
    bodyFormat: presented.bodyFormat ?? (presented.body ? 'mono' : null),
    kv: presented.kv ?? null,
    legacyTruncated: presented.legacyTruncated ?? false,
    fieldTruncated: presented.fieldTruncated ?? false,
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
