import type { TestProject } from 'vitest/node';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';

/**
 * One Postgres + one Redis container for the WHOLE integration run.
 *
 * Rationale: per-suite containers (2 × 10 suites) create enough start/stop
 * churn on Docker Desktop that its port-forward proxies stall for tens of
 * seconds mid-suite — BullMQ blocking connections stop picking waiting jobs
 * and polling tests flake (~50% of full runs; every suite green in isolation).
 * Suite isolation is preserved logically instead: a fresh Postgres DATABASE
 * and a fresh Redis logical DB (SELECT n) per suite — see harness.ts.
 */
export default async function setup(project: TestProject) {
  const pg: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();

  project.provide('PG_ADMIN_URL', pg.getConnectionUri());
  project.provide('REDIS_BASE_URL', redis.getConnectionUrl());

  return async () => {
    await pg.stop();
    await redis.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    PG_ADMIN_URL: string;
    REDIS_BASE_URL: string;
  }
}
