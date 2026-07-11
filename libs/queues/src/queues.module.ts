import { Global, Module, DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { loadAgentsConfig } from '@brigadir/app-config';
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
 *   static names) — loadAgentsConfig() at import is accepted and documented.
 * - The Redis CONNECTION must be lazy: `forRootAsync` defers
 *   buildRedisConnection() to Nest context init, so `REDIS_URL` set in test
 *   beforeAll (or by the process manager) is honored. With eager `forRoot`
 *   every consumer silently fell back to localhost:6379.
 */
@Global()
@Module({})
export class QueuesModule {
  static register(): DynamicModule {
    const config = loadAgentsConfig();
    const executorTypes = [...new Set(Object.values(config.executors).map((e) => e.type))];
    const runQueues = executorTypes.map(runQueueName);
    const allQueues = [...runQueues, RECONCILE_QUEUE];

    return {
      module: QueuesModule,
      imports: [
        BullModule.forRootAsync({
          useFactory: () => ({
            connection: buildRedisConnection(),
            defaultJobOptions: DEFAULT_JOB_OPTIONS,
          }),
        }),
        BullModule.registerQueue(...allQueues.map((name) => ({ name }))),
      ],
      exports: [BullModule],
    };
  }
}
