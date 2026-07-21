import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Channel-failure breadcrumbs (feature 027, US3 / FR-007…FR-008).
 *
 * Tool-сервер — единственный свидетель неудачных доставок callback'ов: при
 * исчерпании retry-бюджета любой callback-тулзы сюда пишется ОДНА компактная
 * JSONL-строка (summary-per-exhaustion, не per-attempt). Worker переливает
 * файл в run_events (`channel_failure`) на выходе прогона и периодическим
 * реконсайлером.
 *
 * Расположение — рядом с outbox, по той же конвенции «dirname(markerPath)»:
 *   <configRoot>/.brigadir-channel/<runId>.jsonl
 * Читатель: libs/executors/src/claude-cli/channel-breadcrumbs.ts.
 * Протокол: specs/027-callback-channel-resilience/contracts/channel-breadcrumbs.md.
 *
 * Поза писателя идентична outbox'у: best-effort, НИКОГДА не бросает, не
 * задерживает и не меняет видимый агенту результат тулзы. Зависимостей нет —
 * форма записи закреплена контракт-схемой в @brigadir/contracts, которую
 * enforce'ит читатель (и юнит-тесты этого пакета).
 */

export const CHANNEL_DIR_NAME = '.brigadir-channel';

/** Кап объёма на прогон (FR-008): дальше append'ы молча пропускаются. */
export const MAX_BREADCRUMB_FILE_BYTES = 65_536;

export interface ChannelBreadcrumbRecord {
  ts: string;
  tool: string;
  kind: 'network' | 'http';
  attempts: number;
  error: { name: string; message: string };
  status?: number;
  /** host:port ТОЛЬКО — никаких путей/заголовков/токенов (Constitution V). */
  target: string;
}

export function channelBreadcrumbFilePath(markerPath: string, runId: string): string {
  return join(dirname(markerPath), CHANNEL_DIR_NAME, `${runId}.jsonl`);
}

/** Append одной записи. Best-effort: любые ошибки ФС проглатываются. */
export async function appendChannelBreadcrumb(
  markerPath: string,
  runId: string,
  record: ChannelBreadcrumbRecord,
): Promise<void> {
  try {
    const file = channelBreadcrumbFilePath(markerPath, runId);
    try {
      const existing = await stat(file);
      if (existing.size >= MAX_BREADCRUMB_FILE_BYTES) return;
    } catch {
      // Файла ещё нет — обычный первый append.
    }
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Никогда не мешаем доставке/результату тулзы из-за диагностики.
  }
}
