import PQueue from 'p-queue';

/**
 * Per-issue write serialization (contracts.md C4 / research D4).
 *
 * A `Map<issueKey, PQueue({concurrency:1})>`: every mutation for a given issue
 * runs one-at-a-time in submission order, while different issues proceed in
 * parallel. The single-writer-per-workspace assumption (spec §0.2) makes
 * in-process serialization sufficient — no distributed lock. Idle queues are
 * evicted so the map does not grow without bound.
 */
export class PerIssueWriteQueue {
  private readonly queues = new Map<string, PQueue>();

  run<T>(issueKey: string, fn: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(issueKey);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.queues.set(issueKey, queue);
      // Evict once fully drained to bound memory; a later write re-creates it.
      queue.on('idle', () => {
        if (queue!.size === 0 && queue!.pending === 0) this.queues.delete(issueKey);
      });
    }
    // p-queue@6 `add` resolves with the task's return value.
    return queue.add(fn) as Promise<T>;
  }

  /** Number of live per-issue queues (test/introspection aid). */
  get liveKeys(): number {
    return this.queues.size;
  }
}
