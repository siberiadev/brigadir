import {
  DEFAULT_ROLE_TEMPLATES,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_BODY_BYTES,
  type ResolvedTemplateSource,
  type RoleTemplate,
} from '@brigadir/contracts';

/**
 * The outcome of resolving a workspace's effective template source: where the
 * templates came from (after any fallback) and the capped template list.
 */
export interface TemplateCatalog {
  source: ResolvedTemplateSource;
  /** Already capped (file count + body size) — ready to project/serve. */
  templates: RoleTemplate[];
}

/** Truncate one body to the byte cap, flagging `truncated` (never silently drop). */
function truncateBody(t: RoleTemplate): RoleTemplate {
  if (Buffer.byteLength(t.body, 'utf8') <= MAX_TEMPLATE_BODY_BYTES) return t;
  const clipped = Buffer.from(t.body, 'utf8').subarray(0, MAX_TEMPLATE_BODY_BYTES).toString('utf8');
  return { ...t, body: `${clipped}\n\n> [template truncated at cap]`, truncated: true };
}

/**
 * Apply the per-source caps deterministically: keep at most MAX_TEMPLATE_FILES
 * templates in lexicographic slug order (overflow dropped — the caller emits a
 * diagnostic), and truncate any oversized body.
 */
export function capTemplates(templates: readonly RoleTemplate[]): RoleTemplate[] {
  return [...templates]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, MAX_TEMPLATE_FILES)
    .map(truncateBody);
}

/**
 * Resolve the effective template source for a workspace.
 *
 * US1 (feature 030): built-in defaults only — no DB read, no network, no
 * secrets. US2 extends this to try the workspace override, then the global
 * setting, then built-ins, fetching a git source server-side with fallback +
 * diagnostics (tasks.md T040).
 */
export function resolveTemplateSource(): TemplateCatalog {
  return { source: { level: 'builtin' }, templates: capTemplates(DEFAULT_ROLE_TEMPLATES) };
}
