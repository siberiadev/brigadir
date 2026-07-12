import { describe, it, expect, vi } from 'vitest';
import type { JiraClient } from '@brigadir/jira';
import { buildFeatureContextSection } from './feature-context';

function fakeJira(ctx: { epic?: { key: string; status: string }; linked: { key: string; status: string; summary: string }[] }): JiraClient {
  return { getFeatureContext: vi.fn().mockResolvedValue(ctx) } as unknown as JiraClient;
}

function fakeDbNoArtifacts(): unknown {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [],
            }),
          }),
        }),
      }),
    }),
  };
}

describe('buildFeatureContextSection (T115, D5/FR-026)', () => {
  it('returns undefined when there is no epic and no linked issues', async () => {
    const jira = fakeJira({ linked: [] });
    const section = await buildFeatureContextSection({ jira, db: fakeDbNoArtifacts() as never }, 'BRIG-1', 'ws-1');
    expect(section).toBeUndefined();
  });

  it('includes the epic and each linked issue with its status', async () => {
    const jira = fakeJira({
      epic: { key: 'BRIG-EPIC', status: 'In Progress' },
      linked: [{ key: 'BRIG-2', status: 'Code Review', summary: 'Sibling work' }],
    });
    const section = await buildFeatureContextSection({ jira, db: fakeDbNoArtifacts() as never }, 'BRIG-1', 'ws-1');
    expect(section).toContain('Epic: BRIG-EPIC [In Progress]');
    expect(section).toContain('BRIG-2 [Code Review] Sibling work');
  });

  it('truncates a 30-linked-issue epic to 20 + "…and 10 more", staying within the ~2KB budget', async () => {
    const linked = Array.from({ length: 30 }, (_, i) => ({
      key: `BRIG-${100 + i}`,
      status: 'Ready for Dev',
      summary: `Sibling ticket number ${i}`,
    }));
    const jira = fakeJira({ epic: { key: 'BRIG-EPIC', status: 'In Progress' }, linked });
    const section = await buildFeatureContextSection({ jira, db: fakeDbNoArtifacts() as never }, 'BRIG-1', 'ws-1');

    expect(section).toBeDefined();
    const text = section as string;
    expect(text).toContain('…and 10 more');
    // exactly 20 issue lines rendered
    const issueLines = text.split('\n').filter((l) => l.startsWith('- BRIG-'));
    expect(issueLines).toHaveLength(20);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('truncates a very long summary to 80 chars', async () => {
    const longSummary = 'x'.repeat(200);
    const jira = fakeJira({ linked: [{ key: 'BRIG-2', status: 'Code Review', summary: longSummary }] });
    const section = await buildFeatureContextSection({ jira, db: fakeDbNoArtifacts() as never }, 'BRIG-1', 'ws-1');
    const line = (section as string).split('\n').find((l) => l.startsWith('- BRIG-2'));
    const prefix = '- BRIG-2 [Code Review] ';
    const renderedSummary = line!.slice(prefix.length);
    expect(renderedSummary.length).toBeLessThanOrEqual(80);
    expect(renderedSummary.endsWith('…')).toBe(true);
  });

  it('is best-effort: a Jira error returns undefined rather than throwing', async () => {
    const jira = { getFeatureContext: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as JiraClient;
    const section = await buildFeatureContextSection({ jira, db: fakeDbNoArtifacts() as never }, 'BRIG-1', 'ws-1');
    expect(section).toBeUndefined();
  });
});
