import type { RoleTemplate } from '@brigadir/contracts';

/**
 * Minimal, permissive frontmatter parser (feature 030) — no YAML dependency.
 * A template file may open with a `---` fenced block of `key: value` string
 * lines; the five known keys are read, unknown keys ignored. Malformed or
 * absent frontmatter is NOT an error — the file is treated as body-only (its
 * role falls back to the slug). This never throws.
 */

const KNOWN_KEYS = new Set([
  'name',
  'role',
  'description',
  'model_hint',
  'trigger_status_hint',
]);

function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Split a file into its frontmatter map and the remaining body. */
function splitFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  // Normalize CRLF so the fence match is line-oriented.
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: text };
  const rawFm = text.slice(4, end);
  // Body starts after the closing fence line.
  const afterFence = text.indexOf('\n', end + 1);
  const body = afterFence === -1 ? '' : text.slice(afterFence + 1).replace(/^\n+/, '');

  const meta: Record<string, string> = {};
  for (const line of rawFm.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (!KNOWN_KEYS.has(key)) continue;
    const value = stripQuotes(trimmed.slice(colon + 1));
    if (value) meta[key] = value;
  }
  return { meta, body };
}

/**
 * Parse one template file into a RoleTemplate. `slug` comes from the file name
 * (never the frontmatter). `role` falls back to the slug when absent.
 */
export function parseTemplateFile(slug: string, content: string): RoleTemplate {
  const { meta, body } = splitFrontmatter(content);
  return {
    slug,
    role: meta.role ?? slug,
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.model_hint !== undefined ? { model_hint: meta.model_hint } : {}),
    ...(meta.trigger_status_hint !== undefined ? { trigger_status_hint: meta.trigger_status_hint } : {}),
    body: body.length > 0 ? body : content.replace(/\r\n/g, '\n'),
  };
}
