import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import { RunsService } from '@brigadir/runs';
import { PipelineService } from '@brigadir/pipeline';
import { ReportSchema } from '@brigadir/contracts';
import { scrubAgentReport } from '@brigadir/callback';
import {
  resolveMcpConfigRoot,
  listOutboxEntries,
  readOutboxReport,
  consumeOutbox,
  listChannelBreadcrumbFiles,
  listOrphanedClaims,
  consumeClaimedBreadcrumbs,
  type ChannelBreadcrumbFile,
  type OutboxEntry,
} from '@brigadir/executors';
import { attachUndeliveredReport } from './undelivered-report';
import { ingestChannelBreadcrumbs } from './channel-breadcrumb-ingest';

/** Default retention for unresolvable outbox files (feature 026, Clarification Q4). */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Outbox files are named `<runId>.json`; a stem that is not a UUID is junk we can't resolve. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Periodic outbox reconciler (feature 026, US3). One `run()` is a single scan
 * of the durable outbox directory that rescues orphaned reports the exit-time
 * path never got to — a worker death, a lost race, an operator cancel. Every
 * finalization goes through the status-guarded RunsService paths, so it is
 * idempotent and race-safe against a live callback landing concurrently
 * (CLAUDE.md rule 7): the loser of any race is a no-op that just consumes the
 * file. Decisions are keyed on the run's CURRENT status — the outbox file
 * never overrides Postgres (Principle I).
 */
@Injectable()
export class OutboxReconcileService {
  private readonly logger = new Logger(OutboxReconcileService.name);
  /** Warn-once-per-worker-lifetime set so a permanently-invalid file doesn't spam every 60s tick. */
  private readonly warnedInvalid = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly runs: RunsService,
    private readonly pipeline: PipelineService,
  ) {}

  async run(): Promise<void> {
    const configRoot = resolveMcpConfigRoot();
    const retentionMs = Number(process.env.BRIGADIR_OUTBOX_RETENTION_MS) || DEFAULT_RETENTION_MS;
    const nowMs = Date.now();

    const entries = await listOutboxEntries(configRoot);
    for (const entry of entries) {
      try {
        await this.reconcileEntry(configRoot, entry, nowMs, retentionMs);
      } catch (err) {
        // A single bad file must not abort the whole sweep.
        this.logger.error(`outbox reconcile failed for ${entry.filePath}: ${String(err)}`);
      }
    }

    // Feature 027 (US3): второй скан — channel-failure breadcrumbs. Ловит
    // файлы, которые exit-path не перелил (смерть worker'а, пропущенная
    // ветка). Только терминальные прогоны: у активных агент ещё может
    // дописывать. Идемпотентность с exit-path — rename-claim внутри ingest.
    await this.sweepChannelBreadcrumbs(configRoot, nowMs, retentionMs);
  }

  private async sweepChannelBreadcrumbs(
    configRoot: string,
    nowMs: number,
    retentionMs: number,
  ): Promise<void> {
    const files = await listChannelBreadcrumbFiles(configRoot);
    for (const file of files) {
      try {
        await this.sweepBreadcrumbFile(file, nowMs, retentionMs);
      } catch (err) {
        this.logger.error(`channel breadcrumb sweep failed for ${file.filePath}: ${String(err)}`);
      }
    }
    // Осиротевшие claim'ы (`.jsonl.ingesting` от умершего между claim и rm
    // worker'а): только retention — повторный ingest мог бы задвоить строки,
    // чьи insert'ы частично легли (contracts/channel-breadcrumbs.md).
    for (const claim of await listOrphanedClaims(configRoot)) {
      if (nowMs - claim.mtimeMs <= retentionMs) continue;
      this.logger.warn(
        `channel breadcrumbs: retention — deleting orphaned claim ${claim.filePath}`,
      );
      await consumeClaimedBreadcrumbs(claim.filePath);
    }
  }

  private async sweepBreadcrumbFile(
    file: ChannelBreadcrumbFile,
    nowMs: number,
    retentionMs: number,
  ): Promise<void> {
    const key = `channel:${file.runId}`;
    if (!UUID_RE.test(file.runId)) {
      this.warnOnceKey(key, `channel breadcrumb filename is not a run id (${file.filePath})`);
      await this.applyBreadcrumbRetention(file, nowMs, retentionMs, key);
      return;
    }

    const [run] = await this.db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, file.runId))
      .limit(1);

    if (!run) {
      // Неатрибутируемое свидетельство: держим окно retention, потом удаляем
      // с лог-строкой (та же поза, что у нечитабельного outbox'а).
      this.warnOnceKey(key, `channel breadcrumbs for unknown run ${file.runId} (${file.filePath})`);
      await this.applyBreadcrumbRetention(file, nowMs, retentionMs, key);
      return;
    }

    if (run.status === 'queued' || run.status === 'running' || run.status === 'awaiting_human') {
      // Активный прогон — файл может ещё пополняться; не трогаем.
      return;
    }

    await ingestChannelBreadcrumbs(this.db, file.runId, 'reconcile');
  }

  private warnOnceKey(key: string, message: string): void {
    if (this.warnedInvalid.has(key)) return;
    this.warnedInvalid.add(key);
    this.logger.warn(`${message} — keeping for inspection`);
  }

  private async applyBreadcrumbRetention(
    file: ChannelBreadcrumbFile,
    nowMs: number,
    retentionMs: number,
    key: string,
  ): Promise<void> {
    if (nowMs - file.mtimeMs <= retentionMs) return;
    this.logger.warn(
      `channel breadcrumbs: retention — deleting unresolvable file ${file.filePath}`,
    );
    await consumeClaimedBreadcrumbs(file.filePath);
    this.warnedInvalid.delete(key);
  }

  private async reconcileEntry(
    configRoot: string,
    entry: OutboxEntry,
    nowMs: number,
    retentionMs: number,
  ): Promise<void> {
    const { runId } = entry;
    // A non-UUID stem can't be a real run id (and would make the uuid-typed
    // lookup throw). Treat it as unresolvable junk: keep for inspection, age
    // out via retention.
    if (!UUID_RE.test(runId)) {
      this.warnOnceInvalid(runId, entry, 'outbox filename is not a run id');
      await this.applyRetention(entry, nowMs, retentionMs);
      return;
    }

    const [run] = await this.db
      .select({ status: schema.runs.status, outcome: schema.runs.outcome })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);

    // Unknown run id — nothing to reconcile against. Discard so the dir stays clean.
    if (!run) {
      this.logger.warn(`outbox: no run ${runId} — discarding orphaned report ${entry.filePath}`);
      await consumeOutbox(configRoot, runId);
      return;
    }

    const raw = await readOutboxReport(configRoot, runId);
    if (raw === null) {
      // Present but unreadable (corrupt JSON / runId mismatch). Keep for
      // inspection; age out via retention. Warn once per worker lifetime.
      this.warnOnceInvalid(runId, entry, 'unreadable outbox file');
      await this.applyRetention(entry, nowMs, retentionMs);
      return;
    }

    let report;
    try {
      report = scrubAgentReport(ReportSchema.parse(raw));
    } catch {
      this.warnOnceInvalid(runId, entry, 'outbox report fails ReportSchema');
      await this.applyRetention(entry, nowMs, retentionMs);
      return;
    }

    const status = run.status;
    const rescuable =
      status === 'running' ||
      ((status === 'failed' || status === 'timed_out') && run.outcome === null);

    if (rescuable) {
      const flipped = await this.runs.reconcileWithReport(runId, report);
      if (flipped) {
        this.logger.log(`outbox: rescued run ${runId} (${status}) → ${report.outcome}`);
        await this.afterFinalize(runId);
      }
      await consumeOutbox(configRoot, runId);
      return;
    }

    if (status === 'cancelled' || status === 'superseded') {
      // Intentional stop — never flip the status, but surface the verdict.
      await attachUndeliveredReport(this.db, runId, report, status, 'periodic_reconcile');
      await consumeOutbox(configRoot, runId);
      return;
    }

    if (status === 'awaiting_human' || status === 'queued') {
      // A live completion path still owns this run — leave the file untouched.
      return;
    }

    // Already finalized with an outcome (succeeded, or failed/timed_out that a
    // report already resolved). Nothing to do — discard.
    await consumeOutbox(configRoot, runId);
  }

  private warnOnceInvalid(runId: string, entry: OutboxEntry, why: string): void {
    if (this.warnedInvalid.has(runId)) return;
    this.warnedInvalid.add(runId);
    this.logger.warn(`outbox: ${why} for run ${runId} (${entry.filePath}) — keeping for inspection`);
  }

  private async applyRetention(entry: OutboxEntry, nowMs: number, retentionMs: number): Promise<void> {
    if (nowMs - entry.mtimeMs <= retentionMs) return;
    this.logger.warn(`outbox: retention — deleting unresolvable file ${entry.filePath} (older than retention window)`);
    await consumeOutbox(resolveMcpConfigRoot(), entry.runId);
    this.warnedInvalid.delete(entry.runId);
  }

  private async afterFinalize(runId: string): Promise<void> {
    try {
      await this.pipeline.onRunFinished(runId);
    } catch (err) {
      this.logger.error(`onRunFinished failed for run ${runId} (will be repaired on reconcile): ${String(err)}`);
    }
  }
}
