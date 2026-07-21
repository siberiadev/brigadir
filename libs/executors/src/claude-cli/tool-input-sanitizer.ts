/**
 * Pure sanitizer for a tool_use block's `input` before it is persisted as a
 * `tool_call` run_event (feature 026, contracts/tool-call-payload.md). Replaces
 * the old `truncate(JSON.stringify(input))` so the timeline always receives a
 * STRUCTURED object it can decompose — never a cut-off JSON string.
 *
 * Policy, applied to every string field BY KEY, at any depth:
 *  - Human-authored text (message/title/details/summary): kept in full, scrubbed.
 *  - File content (content/new_string/old_string): replaced with a
 *    "<file content, N KB>" size placeholder — the body is never stored.
 *  - Every other string: scrubbed, then capped at MAX_FIELD_CHARS; a genuine
 *    cut sets `truncated`.
 *
 * Recursion is deliberate (Constitution V): a `complete_task` input carries the
 * whole report, so nested agent strings (`checks[].reason`, `artifacts.*`) must
 * be scrubbed too — the tool_call event is a real DB sink. Non-string leaves
 * pass through; the walk is cycle-guarded and never throws.
 */

/** Human-authored prose — never truncated (scrubbed only). */
const HUMAN_TEXT_FIELDS = new Set(['message', 'title', 'details', 'summary']);
/** File bodies — replaced with a size placeholder, not stored. */
const FILE_CONTENT_FIELDS = new Set(['content', 'new_string', 'old_string']);
/** Per-field cap for generic (non-human, non-file) strings. */
const MAX_FIELD_CHARS = 2000;

export interface SanitizedToolInput {
  input: Record<string, unknown>;
  truncated: boolean;
}

type Scrub = (s: string) => string;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function fileSizePlaceholder(value: string): string {
  const kb = Math.max(1, Math.round(value.length / 1024));
  return `<file content, ${kb} KB>`;
}

/**
 * @param _toolName reserved for a future tool-aware policy; the current policy
 *   is decided purely by field key, so it is unused today.
 */
export function sanitizeToolInput(
  _toolName: string,
  rawInput: unknown,
  scrub: Scrub,
): SanitizedToolInput {
  let truncated = false;
  const seen = new WeakSet<object>();

  const sanitizeString = (key: string, value: string): string => {
    if (FILE_CONTENT_FIELDS.has(key)) return fileSizePlaceholder(value);
    const scrubbed = scrub(value);
    if (HUMAN_TEXT_FIELDS.has(key)) return scrubbed;
    if (scrubbed.length > MAX_FIELD_CHARS) {
      truncated = true;
      return scrubbed.slice(0, MAX_FIELD_CHARS);
    }
    return scrubbed;
  };

  const walk = (key: string, value: unknown): unknown => {
    if (typeof value === 'string') return sanitizeString(key, value);
    if (Array.isArray(value)) {
      if (seen.has(value)) return [];
      seen.add(value);
      // Array elements inherit the array's key (e.g. `commits` → each string
      // is a generic `commits` field), so they scrub/cap like any other string.
      return value.map((v) => walk(key, v));
    }
    if (isPlainObject(value)) {
      if (seen.has(value)) return {};
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(k, v);
      return out;
    }
    return value; // number | boolean | null | undefined
  };

  const rec = isPlainObject(rawInput) ? rawInput : {};
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) input[k] = walk(k, v);
  return { input, truncated };
}
