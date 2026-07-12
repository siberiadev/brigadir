import { Global, Module, DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RUN_QUEUE_EXECUTOR_TYPES } from '@brigadir/contracts';
import {
  RECONCILE_QUEUE,
  runQueueName,
  DEFAULT_JOB_OPTIONS,
  buildRedisConnection,
} from './queue.constants';

/**
 * Queue registry (T018). Registers one `run.<executorType>` queue per distinct
 * executor type in the loaded config (iteration 1: `run.mock`) plus the
 * `reconcile` queue, on a shared connection with `maxRetriesPerRequest: null`
 * and the spec's default job retention. Global so a single import at the app
 * root makes every queue provider available app-wide (RunTriggerService resolves
 * them via ModuleRef).
 *
 * Timing matters here: `register()` runs at MODULE IMPORT time (decorator
 * argument), so anything it reads must not depend on env set later.
 * - Queue NAMES are composition-time by design (registerQueue/@Processor need
 *   static names). The source of the `run.<type>` set is the fixed
 *   `RUN_QUEUE_EXECUTOR_TYPES` registry (@brigadir/contracts) — NOT the yaml
 *   (feature 005, R4/FR-018). This severed the worker's last composition-time
 *   `loadAgentsConfig()` read, so `agents.yaml` is fully optional at boot for
 *   both processes; the registry is static structure (lazy-resolution carve-out).
 * - The Redis CONNECTION must be lazy: `forRootAsync` defers
 *   buildRedisConnection() to Nest context init, so `REDIS_URL` set in test
 *   beforeAll (or by the process manager) is honored. With eager `forRoot`
 *   every consumer silently fell back to localhost:6379.
 */
@Global()
@Module({})
export class QueuesModule {
  static register(): DynamicModule {
    const runQueues = RUN_QUEUE_EXECUTOR_TYPES.map(runQueueName);
    const allQueues = [...runQueues, RECONCILE_QUEUE];

    return {
      module: QueuesModule,
      imports: [
        BullModule.forRootAsync({
          useFactory: () => ({
            connection: buildRedisConnection(),
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
            // Key namespace for every queue/worker this app creates. Production
            // keeps the BullMQ default ('bull'). Integration suites set a
            // UNIQUE prefix per suite (harness.startRedis): 37+ suites rotate
            // over only 15 Redis logical DBs, so two concurrent suites CAN
            // share a DB — without distinct prefixes a co-tenant's worker
            // consumes foreign jobs ("run not found — dropping job") and its
            // twin's runs hang at `queued`. Read lazily here (forRootAsync),
            // same discipline as the connection.
            prefix: process.env.BULLMQ_PREFIX ?? 'bull',
          }),
        }),
        BullModule.registerQueue(...allQueues.map((name) => ({ name }))),
      ],
      exports: [BullModule],
    };
  }
}
