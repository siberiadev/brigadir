import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { DRIZZLE, type BrigadirDb } from '@brigadir/database';
import { buildRedisConnection } from '@brigadir/queues';

export interface HealthReport {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  redis: 'up' | 'down';
}

/** DB + Redis liveness probes (contracts C7). */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {
    const conn = buildRedisConnection();
    this.redis = new Redis({
      host: conn.host,
      port: conn.port,
      username: conn.username,
      password: conn.password,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }

  async check(): Promise<HealthReport> {
    const [db, redis] = await Promise.all([this.pingDb(), this.pingRedis()]);
    return { status: db === 'up' && redis === 'up' ? 'ok' : 'degraded', db, redis };
  }

  private async pingDb(): Promise<'up' | 'down'> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async pingRedis(): Promise<'up' | 'down'> {
    try {
      await this.redis.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
