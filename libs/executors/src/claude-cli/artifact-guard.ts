import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveMcpServerEntryPath, resolveMcpServerSrcDir } from './mcp-server-path';

/**
 * Deployment guard — "merged = deployed" (feature 026, US2/slice A). The
 * worker spawns `packages/mcp-server/dist/main.js`, a manually built
 * artifact. When sources are edited but the artifact is not rebuilt, agents
 * run a stale binary (the root cause of run 3f60c1a1 shipping without the
 * outbox code). This module detects that BEFORE any callback-wired agent
 * spawns and fails loudly — no silent fallback (CLAUDE.md rule 1).
 *
 * Freshness is a same-machine mtime comparison: the artifact must be no older
 * than the newest file under the tool-server source tree. Content hashing
 * would add nothing on one machine — the remedy for a false positive is a
 * rebuild, which is cheap.
 */

export interface ArtifactGuardInput {
  entryPath: string;
  srcDir: string;
}

export type ArtifactGuardVerdict =
  | { ok: true; skipped?: 'no-src-dir' }
  | { ok: false; reason: 'missing'; entryPath: string }
  | {
      ok: false;
      reason: 'stale';
      entryPath: string;
      entryMtimeMs: number;
      newestSrcPath: string;
      newestSrcMtimeMs: number;
    };

interface NewestFile {
  path: string;
  mtimeMs: number;
}

/** Recursively find the most-recently-modified file under `dir`, or null if the dir is absent/empty. */
async function newestFileUnder(dir: string): Promise<NewestFile | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null; // dir absent (or unreadable) — caller treats as "no baseline"
  }
  let newest: NewestFile | null = null;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const childNewest = await newestFileUnder(full);
      if (childNewest && (!newest || childNewest.mtimeMs > newest.mtimeMs)) newest = childNewest;
    } else if (entry.isFile()) {
      try {
        const s = await stat(full);
        if (!newest || s.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: s.mtimeMs };
      } catch {
        // transient — skip this file
      }
    }
  }
  return newest;
}

/**
 * Pure artifact-freshness check. `missing` when the entry file does not exist;
 * `stale` when its mtime precedes the newest source file's; otherwise ok. If
 * the source tree is absent (pruned-source deployment) the guard degrades to
 * an existence-only check with `skipped: 'no-src-dir'`.
 */
export async function checkMcpServerArtifact(input: ArtifactGuardInput): Promise<ArtifactGuardVerdict> {
  let entryMtimeMs: number;
  try {
    entryMtimeMs = (await stat(input.entryPath)).mtimeMs;
  } catch {
    return { ok: false, reason: 'missing', entryPath: input.entryPath };
  }

  const newestSrc = await newestFileUnder(input.srcDir);
  if (!newestSrc) return { ok: true, skipped: 'no-src-dir' };

  if (entryMtimeMs < newestSrc.mtimeMs) {
    return {
      ok: false,
      reason: 'stale',
      entryPath: input.entryPath,
      entryMtimeMs,
      newestSrcPath: newestSrc.path,
      newestSrcMtimeMs: newestSrc.mtimeMs,
    };
  }
  return { ok: true };
}

/** Human-facing, actionable banner for a guard violation (loud failure surface, FR-002). */
export function formatArtifactGuardError(verdict: Extract<ArtifactGuardVerdict, { ok: false }>): string {
  const remedy = 'Rebuild it: `pnpm build:mcp-server` (or `pnpm build`).';
  if (verdict.reason === 'missing') {
    return (
      `DEPLOYMENT GUARD: agent tool-server artifact is MISSING at ${verdict.entryPath}. ` +
      `Callback-wired runs cannot spawn a working callback channel without it. ${remedy}`
    );
  }
  return (
    `DEPLOYMENT GUARD: agent tool-server artifact is STALE. ` +
    `${verdict.entryPath} (built ${new Date(verdict.entryMtimeMs).toISOString()}) is older than ` +
    `${verdict.newestSrcPath} (modified ${new Date(verdict.newestSrcMtimeMs).toISOString()}). ` +
    `Agents would run outdated tool-server code. ${remedy}`
  );
}

/**
 * A memoized guard over the default resolved paths (feature 026, research
 * D1). The processor consults this per pickup; memoizing for `ttlMs` keeps the
 * stat-walk off the hot path while still re-evaluating soon after a rebuild —
 * so a fresh build heals the worker WITHOUT a restart. Paths are read lazily
 * (env overrides honored) on the first non-cached call.
 */
export interface MemoizedArtifactGuard {
  check(nowMs: number): Promise<ArtifactGuardVerdict>;
}

export function createMemoizedArtifactGuard(ttlMs = 10_000): MemoizedArtifactGuard {
  let cached: { verdict: ArtifactGuardVerdict; atMs: number } | undefined;
  return {
    async check(nowMs: number): Promise<ArtifactGuardVerdict> {
      if (cached && nowMs - cached.atMs < ttlMs) return cached.verdict;
      const verdict = await checkMcpServerArtifact({
        entryPath: resolveMcpServerEntryPath(),
        srcDir: resolveMcpServerSrcDir(),
      });
      cached = { verdict, atMs: nowMs };
      return verdict;
    },
  };
}
