import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Worker } from 'bullmq';
import { WorkerLockService } from './worker-lock.service';
import { RunProcessor } from './run.processor';
import { ClaudeCliRunProcessor } from './claude-cli-run.processor';
import { KimiRunProcessor } from './kimi-run.processor';
import { DeepseekRunProcessor } from './deepseek-run.processor';
import { ReconcileProcessor } from './reconcile.processor';
import { OutboxReconcileProcessor } from './outbox-reconcile.processor';

/**
 * Гейтит ВСЁ потребление очередей (run.* + оба реконсайлера) эксклюзивным
 * worker-lock'ом (feature 027, FR-004). Все процессоры объявлены с
 * `autorun: false` — BullMQ Worker'ы создаются, но НЕ стартуют главный цикл,
 * пока лок не взят: окна «успел схватить job до pause» не существует вовсе.
 *
 * Shutdown: сначала СВОЙ drain (`worker.close()` ждёт активные джобы; повторный
 * close от @nestjs/bullmq — no-op), и только потом release лока — контендер не
 * может начать потреблять, пока наши in-flight прогоны не завершились
 * (drain-based mode switch, clarify-решение 2026-07-21).
 */
@Injectable()
export class WorkerLockBootstrap implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLockBootstrap.name);
  private started = false;

  constructor(
    private readonly lock: WorkerLockService,
    private readonly runProcessor: RunProcessor,
    private readonly claudeCliProcessor: ClaudeCliRunProcessor,
    private readonly kimiProcessor: KimiRunProcessor,
    private readonly deepseekProcessor: DeepseekRunProcessor,
    private readonly reconcileProcessor: ReconcileProcessor,
    private readonly outboxReconcileProcessor: OutboxReconcileProcessor,
  ) {}

  private workers(): Worker[] {
    return [
      this.runProcessor.worker,
      this.claudeCliProcessor.worker,
      this.kimiProcessor.worker,
      this.deepseekProcessor.worker,
      this.reconcileProcessor.worker,
      this.outboxReconcileProcessor.worker,
    ].filter((w): w is Worker => Boolean(w));
  }

  async onApplicationBootstrap(): Promise<void> {
    this.started = true;
    await this.lock.start({
      onAcquired: () => this.resumeAll(),
      onLost: () => this.pauseAll(),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.started) {
      // compile() без init() (часть сьютов) — лок не стартовал, отдавать нечего.
      await this.lock.stop();
      return;
    }
    // Drain до release: close() ждёт активные джобы каждого воркера.
    await Promise.allSettled(this.workers().map((w) => w.close()));
    await this.lock.stop();
  }

  private async resumeAll(): Promise<void> {
    for (const worker of this.workers()) {
      // Порядок проверок критичен (инцидент 2026-07-28). `pause(true)` без
      // активных джоб роняет mainLoop (`while (!closing && !paused)`), поэтому
      // после onLost воркер оказывается ОДНОВРЕМЕННО paused=true и
      // running=false. `run()` в этом состоянии молча возвращается на своём
      // `if (closing || paused) return`, а флаг снимает ТОЛЬКО resume() — при
      // обратном порядке ветка resume недостижима и воркер навсегда перестаёт
      // потреблять, продолжая держать лок и логировать «enabled».
      if (worker.isPaused()) {
        // resume() сам поднимет главный цикл, если тот уже вышел.
        worker.resume();
        continue;
      }
      if (!worker.isRunning()) {
        // autorun:false — первый старт главного цикла. run() резолвится только
        // при close(), поэтому намеренно без await; ошибки цикла — в лог.
        worker.run().catch((err: unknown) => {
          this.logger.error(`worker run loop failed: ${(err as Error).message}`);
        });
      }
    }
    this.logger.log('worker-lock held — queue consumption enabled');
  }

  private async pauseAll(): Promise<void> {
    // pause(true): не ждать активные джобы (они дорабатывают), но новые
    // пикапы прекратить немедленно — гонка двух консьюмеров исключается.
    await Promise.allSettled(this.workers().map((w) => w.pause(true)));
    this.logger.error('queue consumption paused — worker-lock is not held');
  }
}
