import { readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ChannelBreadcrumbRecordSchema,
  type ChannelBreadcrumbRecord,
} from '@brigadir/contracts';

/**
 * Reader half of the channel-failure breadcrumbs (feature 027, US3). The tool
 * server (`packages/mcp-server/src/channel-breadcrumbs.ts`) appends one JSONL
 * record per retry exhaustion to `<configRoot>/.brigadir-channel/<runId>.jsonl`;
 * the worker ingests those records as `channel_failure` run-events at run exit
 * and via the periodic reconciler.
 *
 * Идемпотентность двух гоняющихся путей ingestion'а — АТОМАРНЫЙ rename-claim:
 * победитель переименовывает файл в `<...>.jsonl.ingesting` и владеет им
 * эксклюзивно; проигравший ловит ENOENT и no-op'ится. Никакого DB-side dedup
 * не существует и не требуется (contracts/channel-breadcrumbs.md).
 */

export const CHANNEL_BREADCRUMB_DIR_NAME = '.brigadir-channel';

/** Суффикс заклейменного файла (rename-claim). */
export const INGESTING_SUFFIX = '.ingesting';

export function channelBreadcrumbDirPath(configRoot: string): string {
  return join(configRoot, CHANNEL_BREADCRUMB_DIR_NAME);
}

export function channelBreadcrumbFilePath(configRoot: string, runId: string): string {
  return join(channelBreadcrumbDirPath(configRoot), `${runId}.jsonl`);
}

export interface ChannelBreadcrumbFile {
  runId: string;
  filePath: string;
  mtimeMs: number;
}

/**
 * List unclaimed `*.jsonl` files (filename stem = candidate runId) for the
 * periodic reconciler. Missing dir ⇒ empty scan; never throws. Claimed
 * (`.ingesting`) files are excluded — see `listOrphanedClaims`.
 */
export async function listChannelBreadcrumbFiles(
  configRoot: string,
): Promise<ChannelBreadcrumbFile[]> {
  return listBySuffix(configRoot, '.jsonl');
}

/**
 * Orphaned claims: `.jsonl.ingesting` files left by a worker that died between
 * claim and delete. Retention-only (kept for inspection, then removed) — a
 * re-ingest could duplicate rows whose inserts partially landed.
 */
export async function listOrphanedClaims(configRoot: string): Promise<ChannelBreadcrumbFile[]> {
  const entries = await listBySuffix(configRoot, `.jsonl${INGESTING_SUFFIX}`);
  return entries;
}

async function listBySuffix(configRoot: string, suffix: string): Promise<ChannelBreadcrumbFile[]> {
  const dir = channelBreadcrumbDirPath(configRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: ChannelBreadcrumbFile[] = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    // Для '.jsonl' не захватываем заклейменные '<runId>.jsonl.ingesting'.
    if (suffix === '.jsonl' && name.endsWith(INGESTING_SUFFIX)) continue;
    const filePath = join(dir, name);
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      entries.push({ runId: name.slice(0, -suffix.length), filePath, mtimeMs: s.mtimeMs });
    } catch {
      // vanished between readdir and stat — skip.
    }
  }
  return entries;
}

/**
 * Атомарный claim: rename в `<filePath>.ingesting`. Возвращает путь
 * заклейменного файла либо null, если файла нет / его уже забрал другой путь
 * (exit-path vs реконсайлер). Никогда не бросает.
 */
export async function claimChannelBreadcrumbFile(filePath: string): Promise<string | null> {
  const claimed = `${filePath}${INGESTING_SUFFIX}`;
  try {
    await rename(filePath, claimed);
    return claimed;
  } catch {
    return null;
  }
}

export interface ClaimedBreadcrumbs {
  records: ChannelBreadcrumbRecord[];
  /** Строки, не прошедшие JSON.parse или контракт-схему (дропнуты). */
  invalidLines: number;
}

/**
 * Построчный parse заклейменного файла через контракт-схему. Невалидные
 * строки дропаются (счётчик — для warn-once у вызывающего), валидные
 * сохраняются. Никогда не бросает.
 */
export async function readClaimedBreadcrumbs(claimedPath: string): Promise<ClaimedBreadcrumbs> {
  let raw: string;
  try {
    raw = await readFile(claimedPath, 'utf8');
  } catch {
    return { records: [], invalidLines: 0 };
  }
  const records: ChannelBreadcrumbRecord[] = [];
  let invalidLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(ChannelBreadcrumbRecordSchema.parse(JSON.parse(trimmed)));
    } catch {
      invalidLines++;
    }
  }
  return { records, invalidLines };
}

/** Best-effort удаление после ingestion'а. Никогда не бросает. */
export async function consumeClaimedBreadcrumbs(claimedPath: string): Promise<void> {
  try {
    await rm(claimedPath, { force: true });
  } catch {
    // Best-effort.
  }
}
