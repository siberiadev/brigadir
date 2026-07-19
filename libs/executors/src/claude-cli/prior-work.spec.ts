import { describe, it, expect } from 'vitest';
import type { NormalizedRepoArtifact } from '@brigadir/contracts';
import { matchReportedBranches } from './prior-work';
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
