import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { buildRedisConnection } from '@brigadir/queues';

/**
 * Эксклюзивный worker-lock (feature 027, US2/FR-004): на один BullMQ-неймспейс
 * консьюмит РОВНО один worker-процесс. Защищает от «dev-worker забыт + стартует
 * стабильный worker» — второй процесс не потребляет очереди и громко ругается
 * с ОБЕИХ сторон (contender-ключ виден держателю), пока держатель не отдаст
 * лок (drain-based переключение) или не умрёт (bounded takeover ≤ TTL).
 *
 * Redis здесь — координация, transient flag (Constitution I): потеря ключа не
 * теряет никакого состояния, только заставляет пере-выбрать консьюмера.
 * Контракт: specs/027-callback-channel-resilience/contracts/worker-lock.md.
 */

export interface WorkerLockIdentity {
  mode: string;
  pid: number;
  hostname: string;
  acquired_at: string;
}

export interface WorkerLockCallbacks {
  /** Лок взят (первично или после потери) — можно потреблять очереди. */
  onAcquired: () => Promise<void> | void;
  /** Лок потерян (renewal не прошёл) — потребление НЕМЕДЛЕННО остановить. */
  onLost: () => Promise<void> | void;
}

export type WorkerLockState = 'idle' | 'blocked' | 'held';

export const DEFAULT_WORKER_LOCK_TTL_MS = 15_000;
/** TTL contender-ключа — фиксированная часть контракта (не env). */
export const CONTENDER_TTL_MS = 30_000;

export function workerLockKey(prefix: string): string {
  return `${prefix}:worker-lock`;
}

export function contenderKeyOf(prefix: string): string {
  return `${prefix}:worker-lock:contender`;
}

/** Продление — каждые TTL/3 (guard от вырожденно частых тиков при малых TTL в тестах). */
export function renewIntervalMs(ttlMs: number): number {
  return Math.max(100, Math.floor(ttlMs / 3));
}

/**
 * Каденс попыток взятия у заблокированного контендера: ~2 с в продовых TTL
 * (SC-002 «unmissable within seconds»), пропорционально быстрее при коротких
 * тестовых TTL, чтобы takeover укладывался в TTL + каденс.
 */
export function acquireIntervalMs(ttlMs: number): number {
  return Math.min(2_000, renewIntervalMs(ttlMs));
}

export function buildIdentity(env: NodeJS.ProcessEnv = process.env): WorkerLockIdentity {
  return {
    mode: env.BRIGADIR_WORKER_MODE ?? 'dev',
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };
}

export function formatIdentity(id: WorkerLockIdentity | null): string {
  if (!id) return '<unknown>';
  return `mode=${id.mode} pid=${id.pid} host=${id.hostname} since=${id.acquired_at}`;
}

function parseIdentity(raw: string | null): WorkerLockIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WorkerLockIdentity;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** compare-and-extend: продлеваем только СВОЙ лок. */
const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

/** compare-and-del: снимаем только СВОЙ лок. */
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

@Injectable()
export class WorkerLockService {
  private readonly logger = new Logger(WorkerLockService.name);

  private client?: Redis;
  private callbacks?: WorkerLockCallbacks;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  private lockKey = '';
  private contenderKey = '';
  private ttlMs = DEFAULT_WORKER_LOCK_TTL_MS;
  /** Точная сериализованная identity, лежащая в ключе, — предмет compare-* Lua. */
  private value = '';

  state: WorkerLockState = 'idle';
  /** Последний увиденный держатель (для тестов/диагностики contender-стороны). */
  lastSeenHolder: WorkerLockIdentity | null = null;

  /**
   * Запускает цикл владения. Первый acquire-attempt выполняется синхронно
   * внутри start() — одиночный worker (обычный dev-кейс, интеграционные
   * сьюты) получает лок мгновенно и стартует без задержки.
   * Prefix/TTL читаются ЛЕНИВО здесь (Rule 1) — никаких composition-time reads.
   */
  async start(callbacks: WorkerLockCallbacks): Promise<void> {
    const prefix = process.env.BULLMQ_PREFIX ?? 'bull';
    this.ttlMs = readTtlMs();
    this.lockKey = workerLockKey(prefix);
    this.contenderKey = contenderKeyOf(prefix);
    this.callbacks = callbacks;
    this.stopped = false;
    this.client = new Redis({ ...buildRedisConnection(), lazyConnect: false });
    // ioredis эмитит 'error' и без подписчика валит процесс — логируем сами.
    this.client.on('error', (err: Error) => {
      this.logger.warn(`worker-lock redis error: ${err.message}`);
    });

    await this.tick();
  }

  /** Полная остановка: дренаж уже сделан вызывающей стороной; отдаём лок. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const client = this.client;
    if (!client) return;
    try {
      if (this.state === 'held') {
        await client.eval(RELEASE_LUA, 1, this.lockKey, this.value);
        this.logger.log(`worker-lock released (${this.lockKey})`);
      }
    } catch (err) {
      this.logger.warn(`worker-lock release failed: ${(err as Error).message}`);
    } finally {
      this.state = 'idle';
      this.client = undefined;
      await client.quit().catch(() => client.disconnect());
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // Не держим event loop живым ради лока (voluntary shutdown полагается на Nest hooks).
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.client) return;
    try {
      if (this.state === 'held') {
        await this.renew();
      } else {
        await this.tryAcquire();
      }
    } catch (err) {
      // Redis недоступен: потребление в состоянии held продолжает жить до
      // следующего успешного/неуспешного renewal; здесь только лог + ретрай.
      this.logger.warn(`worker-lock tick failed: ${(err as Error).message}`);
      this.schedule(acquireIntervalMs(this.ttlMs));
    }
  }

  private async tryAcquire(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const candidate = JSON.stringify(buildIdentity());
    const res = await client.set(this.lockKey, candidate, 'PX', this.ttlMs, 'NX');
    if (res === 'OK') {
      this.value = candidate;
      const wasBlocked = this.state === 'blocked';
      this.state = 'held';
      this.logger.log(
        `worker-lock acquired (${this.lockKey})${wasBlocked ? ' after waiting for the previous holder' : ''}`,
      );
      await this.callbacks?.onAcquired();
      this.schedule(renewIntervalMs(this.ttlMs));
      return;
    }

    this.state = 'blocked';
    this.lastSeenHolder = parseIdentity(await client.get(this.lockKey));
    // Громко с нашей стороны + contender-ключ, чтобы держатель тоже увидел.
    this.logger.error(
      `ANOTHER WORKER OWNS THE QUEUES (${this.lockKey}): held by ${formatIdentity(this.lastSeenHolder)} — this worker consumes NOTHING until the lock frees`,
    );
    await client.set(this.contenderKey, JSON.stringify(buildIdentity()), 'PX', CONTENDER_TTL_MS);
    this.schedule(acquireIntervalMs(this.ttlMs));
  }

  private async renew(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const extended = (await client.eval(RENEW_LUA, 1, this.lockKey, this.value, this.ttlMs)) as
      | number
      | null;
    if (extended !== 1) {
      this.state = 'blocked';
      this.logger.error(
        `worker-lock LOST (${this.lockKey}) — pausing all queue consumption immediately`,
      );
      await this.callbacks?.onLost();
      this.schedule(acquireIntervalMs(this.ttlMs));
      return;
    }
    // Держатель тоже обязан быть громким (SC-002 «on both sides»).
    const contender = parseIdentity(await client.get(this.contenderKey));
    if (contender && JSON.stringify(contender) !== this.value) {
      this.logger.error(
        `another worker is attempting to consume these queues: ${formatIdentity(contender)} (it is blocked while this worker holds ${this.lockKey})`,
      );
    }
    this.schedule(renewIntervalMs(this.ttlMs));
  }
}

function readTtlMs(): number {
  const raw = Number(process.env.BRIGADIR_WORKER_LOCK_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_LOCK_TTL_MS;
}
