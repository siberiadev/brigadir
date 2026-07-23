import { z } from 'zod';

/**
 * Agent role instruction templates (feature 030). Curated per-role prompts the
 * orchestrator draws from when it assembles a worker team. Source resolution is
 * per-workspace: workspace override ?? global setting ?? built-in defaults
 * (see @brigadir/agent-templates for the resolver). Templates are consumed in
 * REFERENCE mode — the orchestrator adapts each one to the studied project.
 *
 * This module is the single source of truth for the template shapes AND the
 * caps that bound a source (file count, body size, git op timeout).
 */

/** Max template files read from one source; overflow dropped in lexicographic order + diagnostic. */
export const MAX_TEMPLATE_FILES = 50;
/** Max bytes of a single template body; larger bodies are truncated with a marker + `truncated: true`. */
export const MAX_TEMPLATE_BODY_BYTES = 32_768;
/** Hard timeout for any single git operation against a template source. */
export const GIT_OP_TIMEOUT_MS = 30_000;

/**
 * A git URL is accepted only as an `https://`, `ssh://`, or scp-like
 * (`git@host:path`) address. `file://` and local filesystem paths are rejected
 * — a template source must be a remote repository (anti-LFI / least-surprise).
 * Enforced at the API boundary (write time) AND re-checked at fetch time.
 */
export function isAllowedGitUrl(url: string): boolean {
  if (/^file:\/\//i.test(url)) return false;
  if (/^https:\/\/[^\s]+$/i.test(url)) return true;
  if (/^ssh:\/\/[^\s]+$/i.test(url)) return true;
  // scp-like: user@host:path (path is required, no leading slash on the host part)
  return /^[^@\s/]+@[^\s:/]+:[^\s]+$/.test(url);
}

/** A `subdir` must be a relative path with no `..` segments and no leading `/`. */
function isSafeSubdir(subdir: string): boolean {
  if (subdir.startsWith('/')) return false;
  return !subdir.split(/[\\/]/).some((seg) => seg === '..');
}

/**
 * A template source pointer — where role templates come from. Non-secret by
 * construction: the optional access token lives in a sealed bytea column /
 * sealed global-settings value, NEVER in this shape.
 */
export const AgentInstructionsSourceSchema = z
  .object({
    git_url: z
      .string()
      .min(1)
      .refine(isAllowedGitUrl, {
        message:
          'git_url must be an https://, ssh://, or scp-like (git@host:path) address — file:// and local paths are not allowed',
      }),
    git_ref: z.string().min(1).optional(),
    subdir: z
      .string()
      .min(1)
      .refine(isSafeSubdir, { message: 'subdir must be a relative path without ".." segments' })
      .optional(),
  })
  .strict();
export type AgentInstructionsSource = z.infer<typeof AgentInstructionsSourceSchema>;

/** Catalog projection of a template — no body (kept small for the handoff / list tool). */
export const RoleTemplateSummarySchema = z
  .object({
    slug: z.string().min(1),
    role: z.string().min(1),
    description: z.string().optional(),
    model_hint: z.string().optional(),
    trigger_status_hint: z.string().optional(),
  })
  .strict();
export type RoleTemplateSummary = z.infer<typeof RoleTemplateSummarySchema>;

/** A full template — summary + the prompt body (bounded by MAX_TEMPLATE_BODY_BYTES). */
export const RoleTemplateSchema = RoleTemplateSummarySchema.extend({
  body: z.string(),
  /** Present and true when the body was truncated at the cap. */
  truncated: z.boolean().optional(),
}).strict();
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

export const TEMPLATE_SOURCE_LEVELS = ['workspace', 'global', 'builtin'] as const;
export const TemplateSourceLevelSchema = z.enum(TEMPLATE_SOURCE_LEVELS);
export type TemplateSourceLevel = (typeof TEMPLATE_SOURCE_LEVELS)[number];

/**
 * The per-run outcome of source resolution, including any fallback that
 * occurred. `level` is where templates ACTUALLY came from after fallback;
 * `fallback_from` + `diagnostic` are set when a configured source failed and
 * the chain fell through.
 */
export const ResolvedTemplateSourceSchema = z
  .object({
    level: TemplateSourceLevelSchema,
    git_url: z.string().optional(),
    git_ref: z.string().optional(),
    subdir: z.string().optional(),
    fallback_from: z.enum(['workspace', 'global']).optional(),
    diagnostic: z.string().optional(),
  })
  .strict();
export type ResolvedTemplateSource = z.infer<typeof ResolvedTemplateSourceSchema>;
