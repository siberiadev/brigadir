import { describe, it, expect } from 'vitest';
import {
  slugifyAgentKey,
  ensureUniqueAgentKey,
  ORCHESTRATOR_AGENT_KEY,
  RESERVED_AGENT_KEYS,
} from './agent-key';

/**
 * The ONE canonical agent-key slug (feature 014, FR-005). The same rule is
 * re-expressed in SQL for the backfill (migration 0007) and asserted for parity
 * in an integration test — so this unit spec pins the reference behavior.
 */
describe('slugifyAgentKey (feature 014)', () => {
  it('joins name + role, lowercases, and hyphenates', () => {
    expect(slugifyAgentKey('Hera', 'Reviewer')).toBe('hera-reviewer');
    expect(slugifyAgentKey('Achilles', 'Developer')).toBe('achilles-developer');
    expect(slugifyAgentKey('Atalanta', 'QA')).toBe('atalanta-qa');
  });

  it('collapses runs of non-[a-z0-9] and trims edges', () => {
    expect(slugifyAgentKey('  Hera   the  Great  ', 'Reviewer')).toBe('hera-the-great-reviewer');
    expect(slugifyAgentKey('Neo!!!', 'Developer')).toBe('neo-developer');
    expect(slugifyAgentKey('The Matrix / Agent Smith', null)).toBe('the-matrix-agent-smith');
  });

  it('accepts a name that already contains a space (role omitted)', () => {
    expect(slugifyAgentKey('Hera Reviewer')).toBe('hera-reviewer');
  });

  it('treats null/undefined role as absent (name-only slug)', () => {
    expect(slugifyAgentKey('Achilles')).toBe('achilles');
    expect(slugifyAgentKey('Achilles', null)).toBe('achilles');
    expect(slugifyAgentKey('st3-developer', null)).toBe('st3-developer');
  });

  it('falls back to the role slug when the name yields an empty slug', () => {
    // Non-Latin persona name — the name contributes nothing to the slug.
    expect(slugifyAgentKey('Ахиллес', 'Developer')).toBe('developer');
    expect(slugifyAgentKey('日本語', 'QA')).toBe('qa');
  });

  it('falls back to the generic stem when name AND role are both empty slugs', () => {
    expect(slugifyAgentKey('Ахиллес', null)).toBe('agent');
    expect(slugifyAgentKey('!!!', '???')).toBe('agent');
    expect(slugifyAgentKey('', '')).toBe('agent');
  });
});

describe('ensureUniqueAgentKey (feature 014, FR-008)', () => {
  it('returns the base when it is free', () => {
    expect(ensureUniqueAgentKey('hera-reviewer', new Set())).toBe('hera-reviewer');
  });

  it('appends the smallest free numeric suffix on collision', () => {
    expect(ensureUniqueAgentKey('hera-reviewer', new Set(['hera-reviewer']))).toBe('hera-reviewer-2');
    expect(
      ensureUniqueAgentKey('hera-reviewer', new Set(['hera-reviewer', 'hera-reviewer-2'])),
    ).toBe('hera-reviewer-3');
  });

  it('skips gaps and returns the first free suffix', () => {
    expect(
      ensureUniqueAgentKey('hera-reviewer', new Set(['hera-reviewer', 'hera-reviewer-3'])),
    ).toBe('hera-reviewer-2');
  });

  it('treats reserved keys as always taken — a worker can never get the orchestrator key', () => {
    expect(ensureUniqueAgentKey(ORCHESTRATOR_AGENT_KEY, new Set())).toBe(`${ORCHESTRATOR_AGENT_KEY}-2`);
  });

  it('reserves the orchestrator key', () => {
    expect(ORCHESTRATOR_AGENT_KEY).toBe('brigadir');
    expect(RESERVED_AGENT_KEYS).toContain('brigadir');
  });
});
