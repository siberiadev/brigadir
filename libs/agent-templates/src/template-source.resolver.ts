import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_TEMPLATES,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_BODY_BYTES,
  GIT_OP_TIMEOUT_MS,
  isAllowedGitUrl,
  type ResolvedTemplateSource,
  type RoleTemplate,
} from '@brigadir/contracts';
import {
  getWorkspaceInstructionSource,
  getGlobalInstructionSource,
  type BrigadirDb,
  type StoredInstructionSource,
} from '@brigadir/database';
import { openSecret } from '@brigadir/jira';
import { ensureCachedClone } from './clone-cache';
import { gitAuthEnv } from './git-auth';
import { parseTemplateFile } from './frontmatter';

/**
 * The outcome of resolving a workspace's effective template source: where the
 * templates came from (after any fallback) and the capped template list.
 */
export interface TemplateCatalog {
  source: ResolvedTemplateSource;
  /** Already capped (file count + body size) — ready to project/serve. */
  templates: RoleTemplate[];
}

const DIAGNOSTIC_CAP = 300;

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

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > DIAGNOSTIC_CAP ? `${msg.slice(0, DIAGNOSTIC_CAP)}…` : msg;
}

/** Where cached template clones live (lazy env read — never at module load). */
function templateCacheRoot(): string {
  return process.env.BRIGADIR_TEMPLATE_CACHE_ROOT ?? join(tmpdir(), 'brigadir-template-cache');
}

/**
 * Fetch and parse templates from a configured source. PAIRING RULE (FR-013/T041):
 * the token in `stored` is this level's own token — it is only ever used with
 * this level's own URL, never with a fallback target's URL.
 */
async function fetchFromSource(stored: StoredInstructionSource): Promise<RoleTemplate[]> {
  const src = stored.source;
  if (!src) throw new Error('no source configured');
  // Defense in depth: reject a disallowed URL even if a legacy blob slipped past
  // the write-time validation.
  if (!isAllowedGitUrl(src.git_url)) throw new Error('git_url is not an allowed remote');

  const token = stored.tokenBlob ? openSecret(stored.tokenBlob) : undefined;
  const cacheDir = join(templateCacheRoot(), createHash('sha256').update(src.git_url).digest('hex'));
  await ensureCachedClone({
    url: src.git_url,
    cacheDir,
    ref: src.git_ref,
    env: gitAuthEnv(src.git_url, token),
    timeoutMs: GIT_OP_TIMEOUT_MS,
  });

  const dir = join(cacheDir, src.subdir ?? 'roles');
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();

  const templates: RoleTemplate[] = [];
  for (const file of files) {
    const content = await readFile(join(dir, file), 'utf8');
    templates.push(parseTemplateFile(file.slice(0, -3), content));
  }
  if (templates.length === 0) throw new Error(`no *.md templates found under "${src.subdir ?? 'roles'}"`);
  return templates;
}

function builtinCatalog(carry: Partial<ResolvedTemplateSource>): TemplateCatalog {
  return {
    source: { level: 'builtin', ...carry },
    templates: capTemplates(DEFAULT_ROLE_TEMPLATES),
  };
}

/**
 * Resolve the effective template source for a workspace: workspace override ??
 * global setting ?? built-in defaults. A configured source that fails to fetch
 * NEVER blocks — it falls through to the next level with a diagnostic on the
 * resulting `source` (best-effort, like repo recon). Built-ins always succeed.
 */
export async function resolveTemplateSource(
  db: BrigadirDb,
  workspaceId: string,
): Promise<TemplateCatalog> {
  const ws = await getWorkspaceInstructionSource(db, workspaceId);
  if (ws.source) {
    try {
      return {
        source: {
          level: 'workspace',
          git_url: ws.source.git_url,
          ...(ws.source.git_ref ? { git_ref: ws.source.git_ref } : {}),
          ...(ws.source.subdir ? { subdir: ws.source.subdir } : {}),
        },
        templates: capTemplates(await fetchFromSource(ws)),
      };
    } catch (err) {
      return resolveGlobalOrBuiltin(db, {
        fallback_from: 'workspace',
        diagnostic: `workspace template source failed: ${shortError(err)}`,
      });
    }
  }
  return resolveGlobalOrBuiltin(db, {});
}

async function resolveGlobalOrBuiltin(
  db: BrigadirDb,
  carry: { fallback_from?: 'workspace' | 'global'; diagnostic?: string },
): Promise<TemplateCatalog> {
  const g = await getGlobalInstructionSource(db);
  if (g.source) {
    try {
      return {
        source: {
          level: 'global',
          git_url: g.source.git_url,
          ...(g.source.git_ref ? { git_ref: g.source.git_ref } : {}),
          ...(g.source.subdir ? { subdir: g.source.subdir } : {}),
          ...carry,
        },
        templates: capTemplates(await fetchFromSource(g)),
      };
    } catch (err) {
      const diagnostic = carry.diagnostic
        ? `${carry.diagnostic}; global template source failed: ${shortError(err)}`
        : `global template source failed: ${shortError(err)}`;
      return builtinCatalog({ fallback_from: carry.fallback_from ?? 'global', diagnostic });
    }
  }
  return builtinCatalog(carry);
}
