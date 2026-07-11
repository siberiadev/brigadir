import { describe, it, expect } from 'vitest';
import { PerIssueWriteQueue } from './per-issue-write-queue';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('PerIssueWriteQueue (T045)', () => {
  it('serializes writes to the same issue key in submission order', async () => {
    const q = new PerIssueWriteQueue();
    const order: string[] = [];
    const run = (label: string, delay: number): Promise<void> =>
      q.run('BRIG-1', async () => {
        await sleep(delay);
        order.push(label);
      });

    // Submit A (slow) then B (fast); B must NOT overtake A.
    await Promise.all([run('A', 30), run('B', 1), run('C', 1)]);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('lets different issue keys proceed in parallel', async () => {
    const q = new PerIssueWriteQueue();
    let active = 0;
    let peak = 0;
    const task = (key: string): Promise<void> =>
      q.run(key, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
      });
    await Promise.all([task('BRIG-1'), task('BRIG-2'), task('BRIG-3')]);
    expect(peak).toBe(3);
  });

  it('evicts idle queues to bound memory', async () => {
    const q = new PerIssueWriteQueue();
    await q.run('BRIG-9', async () => undefined);
    // allow the drained 'idle' handler to fire
    await sleep(5);
    expect(q.liveKeys).toBe(0);
  });
});
