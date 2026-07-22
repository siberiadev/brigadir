import { Processor } from '@nestjs/bullmq';
import { runQueueName, backoffStrategy } from '@brigadir/queues';
import { ClaudeCliRunProcessor } from './claude-cli-run.processor';

/**
 * DeepseekRunProcessor (feature 028) — consumes `run.deepseek_api` jobs. The
 * deepseek_api executor IS the Claude CLI harness (parameterized with the
 * DeepSeek provider preset in ExecutorsModule), so this processor is
 * deliberately the SAME class logic: gate admission, markRunning guard,
 * cancel-poll, fail-closed callback finalization, and every
 * `WHERE status='running'` guard are inherited verbatim (CLAUDE.md rule 7).
 * The only specialization is the concurrency budget source: the summed
 * `max_parallel_runs` of ENABLED `deepseek_api` profiles (live re-apply
 * included). `registry.resolve()` still dispatches on the run row's own
 * `executor_type`, so a deepseek job gets the DeepSeek-preset executor
 * instance.
 *
 * `runQueueName('deepseek_api')` in the decorator is a composition-time read
 * of static structure (queue name), the documented Constitution carve-out —
 * same as the parent's and the kimi binding.
 */
@Processor(runQueueName('deepseek_api'), {
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
export class DeepseekRunProcessor extends ClaudeCliRunProcessor {
  protected override readonly executorType: string = 'deepseek_api';
}
