import { Logger } from '@nestjs/common';
import { type BrigadirDb, schema } from '@brigadir/database';
import { scrub } from '@brigadir/scrubber';
import type { ChannelFailureEventPayload, ChannelFailureSource } from '@brigadir/contracts';
import {
  channelBreadcrumbFilePath,
  claimChannelBreadcrumbFile,
  consumeClaimedBreadcrumbs,
  readClaimedBreadcrumbs,
  resolveMcpConfigRoot,
} from '@brigadir/executors';

/** run_events.type для «доставка callback'а сдалась» (feature 027, US3). */
export const CHANNEL_FAILURE_EVENT = 'channel_failure';

const logger = new Logger('ChannelBreadcrumbIngest');

/**
 * Переливка breadcrumb-файла прогона в run_events (feature 027, FR-009).
 * Free function по образцу attachUndeliveredReport (026): вызывается из
 * exit-path процессора (все терминальные ветки callback-wired прогонов) и из
 * периодического реконсайлера.
 *
 * Идемпотентность — исключительно rename-claim на ФС (contracts/
 * channel-breadcrumbs.md): победитель забирает файл, проигравший no-op.
 * Best-effort: НИКОГДА не бросает в финализацию и НИКОГДА не пишет
 * runs.status/outcome (правило 7) — только run_events-строки; поздний
 * ingestion к давно финализированному прогону легитимен (late diagnostics).
 *
 * Возвращает число вставленных событий (0 = файла нет / забрал другой путь).
 */
export async function ingestChannelBreadcrumbs(
  db: BrigadirDb,
  runId: string,
  source: ChannelFailureSource,
): Promise<number> {
  try {
    const filePath = channelBreadcrumbFilePath(resolveMcpConfigRoot(), runId);
    const claimed = await claimChannelBreadcrumbFile(filePath);
    if (!claimed) return 0;

    const { records, invalidLines } = await readClaimedBreadcrumbs(claimed);
    if (invalidLines > 0) {
      logger.warn(
        `channel breadcrumbs for run ${runId}: dropped ${invalidLines} invalid line(s)`,
      );
    }

    if (records.length > 0) {
      const payloads: ChannelFailureEventPayload[] = records.map((record) => ({
        ...record,
        // Секрет-скраббер на пути в БД (Constitution V): сообщения ошибок —
        // единственный free-text из внешнего процесса.
        error: { name: record.error.name, message: scrub(record.error.message) },
        occurred_at: record.ts,
        source,
      }));
      await db.insert(schema.runEvents).values(
        payloads.map((payload) => ({ runId, type: CHANNEL_FAILURE_EVENT, payload })),
      );
      logger.log(
        `channel breadcrumbs for run ${runId}: ingested ${records.length} failure record(s) (${source})`,
      );
    }

    await consumeClaimedBreadcrumbs(claimed);
    return records.length;
  } catch (err) {
    // Диагностика не смеет ломать финализацию прогона.
    logger.warn(`channel breadcrumb ingestion failed for run ${runId}: ${String(err)}`);
    return 0;
  }
}
