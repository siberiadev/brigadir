import { describe, it, expect } from 'vitest';
import type { NormalizedRepoArtifact } from '@brigadir/contracts';
import { detectHandoffViolations, parseObservedHeads } from './completion-gate';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('parseObservedHeads', () => {
  it('parses a valid JSON repo→sha map', () => {
    expect(parseObservedHeads(JSON.stringify({ product: A }))).toEqual({ product: A });
  });

  it('returns null for absent, malformed, or schema-invalid headers', () => {
    expect(parseObservedHeads(undefined)).toBeNull();
    expect(parseObservedHeads(null)).toBeNull();
    expect(parseObservedHeads('')).toBeNull();
    expect(parseObservedHeads('not json')).toBeNull();
    expect(parseObservedHeads(JSON.stringify({ product: 'not-a-sha' }))).toBeNull();
    expect(parseObservedHeads(JSON.stringify(['a']))).toBeNull();
  });

  it('rejects a map larger than the repo cap', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 21; i++) big[`r${i}`] = A;
    expect(parseObservedHeads(JSON.stringify(big))).toBeNull();
  });
});

describe('detectHandoffViolations', () => {
  const v2 = (repo: string, branch?: string): NormalizedRepoArtifact => ({ repo, branch });
  const v1 = (branch?: string): NormalizedRepoArtifact => ({ repo: undefined, branch });

  it('flags a repo whose HEAD moved with no artifact entry (v2)', () => {
    const out = detectHandoffViolations(new Map([['product', A]]), { product: B }, [], 1);
    expect(out).toEqual([{ repo: 'product', startSha: A, observedHead: B }]);
  });

  it('does not flag a moved repo that IS reported (v2 entry present)', () => {
    const out = detectHandoffViolations(new Map([['product', A]]), { product: B }, [v2('product', 'run/T')], 1);
    expect(out).toEqual([]);
  });

  it('does not flag when HEAD did not move', () => {
    const out = detectHandoffViolations(new Map([['product', A]]), { product: A }, [], 1);
    expect(out).toEqual([]);
  });

  it('is silent when evidence is absent (null observed, or repo missing from observed)', () => {
    expect(detectHandoffViolations(new Map([['product', A]]), null, [], 1)).toEqual([]);
    expect(detectHandoffViolations(new Map([['product', A]]), { other: B }, [], 1)).toEqual([]);
    expect(detectHandoffViolations(new Map(), { product: B }, [], 0)).toEqual([]);
  });

  it('attributes a v1 flat report to the single mounted repo (no violation)', () => {
    const out = detectHandoffViolations(new Map([['product', A]]), { product: B }, [v1('run/T')], 1);
    expect(out).toEqual([]);
  });

  it('does NOT attribute a v1 flat report when several repos are mounted', () => {
    const out = detectHandoffViolations(
      new Map([
        ['product', A],
        ['infra', A],
      ]),
      { product: B, infra: C },
      [v1('run/T')],
      2,
    );
    expect(out.map((v) => v.repo).sort()).toEqual(['infra', 'product']);
  });

  it('flags only the moved+unreported repos in a mixed set', () => {
    const out = detectHandoffViolations(
      new Map([
        ['product', A],
        ['infra', A],
        ['docs', A],
      ]),
      { product: B, infra: A, docs: C },
      [v2('infra', 'run/T-infra')],
      3,
    );
    // product moved + unreported ⇒ violation; infra unmoved; docs moved+unreported.
    expect(out.map((v) => v.repo).sort()).toEqual(['docs', 'product']);
  });

  it('treats an amend/reset (different sha, not ancestry) as moved', () => {
    const out = detectHandoffViolations(new Map([['product', A]]), { product: C }, [], 1);
    expect(out).toHaveLength(1);
  });
});
