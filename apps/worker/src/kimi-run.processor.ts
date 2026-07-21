import { Processor } from '@nestjs/bullmq';
import { runQueueName, backoffStrategy } from '@brigadir/queues';
import { ClaudeCliRunProcessor } from './claude-cli-run.processor';

/**
 * KimiRunProcessor (feature 025) — consumes `run.kimi` jobs. The kimi
 * executor IS the Claude CLI harness (parameterized with the Moonshot
 * provider preset in ExecutorsModule), so this processor is deliberately the
 * SAME class logic: gate admission, markRunning guard, cancel-poll,
 * fail-closed callback finalization, and every `WHERE status='running'`
 * guard are inherited verbatim (CLAUDE.md rule 7). The only specialization
 * is the concurrency budget source: the summed `max_parallel_runs` of
 * ENABLED `kimi` profiles (live re-apply included). `registry.resolve()`
 * still dispatches on the run row's own `executor_type`, so a kimi job gets
 * the Moonshot-preset executor instance.
 *
 * `runQueueName('kimi')` in the decorator is a composition-time read of
 * static structure (queue name), the documented Constitution carve-out —
 * same as the parent's binding.
 */
@Processor(runQueueName('kimi'), {
  // Static fallback only — the real limit is executors.max_parallel_runs,
  // applied at bootstrap (executor-concurrency.ts; decorator args cannot
  // read the DB, CLAUDE.md rule #1).
  concurrency: 2,
  maxStalledCount: 0,
  settings: { backoffStrategy },
  // Feature 027: consumption is gated by the exclusive worker lock
  // (WorkerLockBootstrap starts the run loop only once the lock is held).
  autorun: false,
})
export class KimiRunProcessor extends ClaudeCliRunProcessor {
  protected override readonly executorType: string = 'kimi';
}
