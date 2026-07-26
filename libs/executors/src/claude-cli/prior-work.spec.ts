import { describe, it, expect } from 'vitest';
import type { NormalizedRepoArtifact } from '@brigadir/contracts';
import { matchReportedBranches, buildStartPlan } from './prior-work';
import type { WorktreeRepo } from './worktree';

const product: WorktreeRepo = { name: 'product', url: 'file:///p', defaultBranch: 'main' };
const infra: WorktreeRepo = { name: 'infra', url: 'file:///i', defaultBranch: 'main' };

const entry = (e: Partial<NormalizedRepoArtifact>): NormalizedRepoArtifact => e;

/**
 * Feature 023: `artifacts.repos[].repo` is unconstrained, secret-scrubbed agent
 * text that decides which commit the NEXT stage starts from. Matching is
 * deliberately strict — starting a stage on the wrong repository is worse than
 * starting it from the default branch.
 */
describe('matchReportedBranches (feature 023)', () => {
  it('maps a v2 entry onto the repo whose name it matches exactly', () => {
    const result = matchReportedBranches(
      [entry({ repo: 'product', branch: 'run/BRIG-1' })],
      [product, infra],
    );
    expect(result).toEqual({ continueBranches: { product: 'run/BRIG-1' }, unmatched: [] });
  });

  it('falls back to a case-insensitive match', () => {
    const result = matchReportedBranches(
      [entry({ repo: 'Product', branch: 'run/BRIG-1' })],
      [product, infra],
    );
    expect(result.continueBranches).toEqual({ product: 'run/BRIG-1' });
  });

  it('attributes the flat v1 form (no repo name) when exactly one repo is mounted', () => {
    const result = matchReportedBranches([entry({ branch: 'run/BRIG-1' })], [product]);
    expect(result.continueBranches).toEqual({ product: 'run/BRIG-1' });
  });

  it('ignores the flat v1 form when two repos are mounted — attribution would be a guess', () => {
    const result = matchReportedBranches([entry({ branch: 'run/BRIG-1' })], [product, infra]);
    expect(result.continueBranches).toEqual({});
    expect(result.unmatched).toEqual(['run/BRIG-1']);
  });

  it('surfaces a reported repo that matches nothing mounted, without failing', () => {
    // Legitimate: the agent may have self-cloned an out-of-scope repo into
    // `.repos/<name>` (feature 020's escape hatch).
    const result = matchReportedBranches(
      [entry({ repo: 'docs', branch: 'run/BRIG-1' })],
      [product],
    );
    expect(result).toEqual({ continueBranches: {}, unmatched: ['docs'] });
  });

  it('does not do substring or fuzzy matching', () => {
    const result = matchReportedBranches(
      [entry({ repo: 'product-web', branch: 'run/BRIG-1' })],
      [product],
    );
    expect(result.continueBranches).toEqual({});
  });

  it('ignores entries that carry only a pr_url', () => {
    const result = matchReportedBranches(
      [entry({ repo: 'product', pr_url: 'https://example.test/pr/1' })],
      [product],
    );
    expect(result.continueBranches).toEqual({});
  });

  it('takes the first of duplicate repo names, deterministically', () => {
    const result = matchReportedBranches(
      [
        entry({ repo: 'product', branch: 'run/FIRST' }),
        entry({ repo: 'product', branch: 'run/SECOND' }),
      ],
      [product],
    );
    expect(result.continueBranches).toEqual({ product: 'run/FIRST' });
  });

  it('leaves a repo the previous stage never touched to its default branch', () => {
    const result = matchReportedBranches(
      [entry({ repo: 'product', branch: 'run/BRIG-1' })],
      [product, infra],
    );
    expect(result.continueBranches.infra).toBeUndefined();
  });
});

/**
 * Feature 032 (T021/T040/T048): layered per-repository start resolution. Level
 * 3 — the blockers' branches — fills only repositories the ticket's OWN prior
 * work did not claim, and two blockers naming the same repository queue a
 * deterministic merge instead of one silently winning.
 */
describe('buildStartPlan (feature 032)', () => {
  const work = (key: string, runId: string, entries: Partial<NormalizedRepoArtifact>[]) => ({
    key,
    runId,
    entries: entries as NormalizedRepoArtifact[],
  });
  const noOwn = { continueBranches: {}, unmatched: [] };

  it('inherits a single blocker branch for a repo with no own work', () => {
    const plan = buildStartPlan({
      repos: [product, infra],
      own: noOwn,
      blockerWork: [work('ST3-1', 'run-a', [{ repo: 'product', branch: 'run/ST3-1' }])],
    });
    expect(plan.repos.product).toEqual({
      source: 'blocker',
      startBranch: 'run/ST3-1',
      mergeBranches: [],
      blockers: [{ key: 'ST3-1', runId: 'run-a', branch: 'run/ST3-1' }],
    });
    // A repo the blocker never touched still starts from its default branch.
    expect(plan.repos.infra).toEqual({ source: 'default', mergeBranches: [], blockers: [] });
  });

  it('own prior work outranks a blocker PER REPOSITORY, not per run', () => {
    const plan = buildStartPlan({
      repos: [product, infra],
      own: { continueBranches: { product: 'run/MINE' }, unmatched: [] },
      blockerWork: [
        work('ST3-1', 'run-a', [
          { repo: 'product', branch: 'run/ST3-1' },
          { repo: 'infra', branch: 'run/ST3-1-infra' },
        ]),
      ],
    });
    expect(plan.repos.product).toMatchObject({ source: 'own', startBranch: 'run/MINE' });
    // ...while the repo the dependent has NOT touched still inherits.
    expect(plan.repos.infra).toMatchObject({ source: 'blocker', startBranch: 'run/ST3-1-infra' });
  });

  it('two blockers on one repo: first sets the start, the rest are merges (in order)', () => {
    const plan = buildStartPlan({
      repos: [product],
      own: noOwn,
      blockerWork: [
        work('ST3-1', 'run-a', [{ repo: 'product', branch: 'run/A' }]),
        work('ST3-2', 'run-b', [{ repo: 'product', branch: 'run/B' }]),
        work('ST3-3', 'run-c', [{ repo: 'product', branch: 'run/C' }]),
      ],
    });
    expect(plan.repos.product.startBranch).toBe('run/A');
    expect(plan.repos.product.mergeBranches).toEqual(['run/B', 'run/C']);
    expect(plan.repos.product.blockers.map((b) => b.key)).toEqual(['ST3-1', 'ST3-2', 'ST3-3']);
  });

  it('is deterministic in the order the caller supplies (keys are pre-sorted)', () => {
    const build = (order: string[]) =>
      buildStartPlan({
        repos: [product],
        own: noOwn,
        blockerWork: order.map((k) => work(k, `run-${k}`, [{ repo: 'product', branch: `run/${k}` }])),
      }).repos.product;
    expect(build(['ST3-1', 'ST3-2']).startBranch).toBe('run/ST3-1');
    expect(build(['ST3-2', 'ST3-1']).startBranch).toBe('run/ST3-2');
  });

  it('does not merge blockers that name DIFFERENT repositories', () => {
    const plan = buildStartPlan({
      repos: [product, infra],
      own: noOwn,
      blockerWork: [
        work('ST3-1', 'run-a', [{ repo: 'product', branch: 'run/A' }]),
        work('ST3-2', 'run-b', [{ repo: 'infra', branch: 'run/B' }]),
      ],
    });
    expect(plan.repos.product.mergeBranches).toEqual([]);
    expect(plan.repos.infra.mergeBranches).toEqual([]);
    expect(plan.repos.infra.startBranch).toBe('run/B');
  });

  it('ignores a duplicate of the branch already chosen as the start point', () => {
    const plan = buildStartPlan({
      repos: [product],
      own: noOwn,
      blockerWork: [
        work('ST3-1', 'run-a', [{ repo: 'product', branch: 'run/SHARED' }]),
        work('ST3-2', 'run-b', [{ repo: 'product', branch: 'run/SHARED' }]),
      ],
    });
    expect(plan.repos.product.mergeBranches).toEqual([]);
  });

  it('collects blocker work for repositories this run does not mount (FR-010)', () => {
    const plan = buildStartPlan({
      repos: [product],
      own: noOwn,
      blockerWork: [work('ST3-1', 'run-a', [{ repo: 'backend', branch: 'run/API' }])],
    });
    expect(plan.repos.product.source).toBe('default');
    expect(plan.unmounted).toEqual([
      { key: 'ST3-1', runId: 'run-a', repo: 'backend', branch: 'run/API' },
    ]);
  });

  it('keeps OWN unmatched entries on the existing observability-only path', () => {
    // Feature 020's escape hatch: the ticket's own agent may have self-cloned
    // an out-of-scope repo. That is not an unmounted-BLOCKER diagnostic.
    const plan = buildStartPlan({
      repos: [product],
      own: { continueBranches: {}, unmatched: ['docs'] },
      blockerWork: [],
    });
    expect(plan.unmatched).toEqual(['docs']);
    expect(plan.unmounted).toEqual([]);
  });

  it('a blocker with no branch-bearing entries contributes nothing', () => {
    const plan = buildStartPlan({
      repos: [product],
      own: noOwn,
      blockerWork: [work('ST3-1', 'run-a', [{ repo: 'product', pr_url: 'https://x/1' }])],
    });
    expect(plan.repos.product).toEqual({ source: 'default', mergeBranches: [], blockers: [] });
  });

  it('applies the same strict repo matching as own prior work (case-insensitive, never fuzzy)', () => {
    const ci = buildStartPlan({
      repos: [product],
      own: noOwn,
      blockerWork: [work('ST3-1', 'run-a', [{ repo: 'Product', branch: 'run/A' }])],
    });
    expect(ci.repos.product.startBranch).toBe('run/A');

    const fuzzy = buildStartPlan({
      repos: [product],
      own: noOwn,
      blockerWork: [work('ST3-1', 'run-a', [{ repo: 'product-web', branch: 'run/A' }])],
    });
    expect(fuzzy.repos.product.source).toBe('default');
    expect(fuzzy.unmounted).toHaveLength(1);
  });
});
