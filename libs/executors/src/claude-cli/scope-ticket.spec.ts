import { describe, it, expect } from 'vitest';
import {
  narrowByTicketComponents,
  composeScopeQuestion,
  RepositoryScopeUndeterminableError,
} from './scope-ticket';

// Decision table from specs/020-jira-components-repo-scoping/contracts/scope-resolution.md —
// one test per row minimum; rows are referenced by number in test names.

const repo = (name: string) => ({ name, url: `git@github.com:acme/${name}.git`, defaultBranch: 'main' });
const base = [repo('backend'), repo('frontend'), repo('infra')];
const workspaceNames = ['backend', 'frontend', 'infra', 'docs-site'];

describe('narrowByTicketComponents (feature 020 — D1/D2/D2a/D2b/D3)', () => {
  it('row 1: scoping disabled ⇒ full base set untouched, gate "off" (D2b, byte-identical legacy)', () => {
    for (const components of [null, [], ['backend'], ['Design']]) {
      const r = narrowByTicketComponents({
        baseRepos: base,
        components,
        workspaceRepoNames: workspaceNames,
        scopingEnabled: false,
      });
      expect(r.kind).toBe('resolved');
      if (r.kind !== 'resolved') throw new Error('unreachable');
      expect(r.repos).toEqual(base);
      expect(r.decision.gate).toBe('off');
      expect(r.decision.effective).toEqual(['backend', 'frontend', 'infra']);
    }
  });

  it('row 2: single-repo base set skips the gate regardless of components (D2a)', () => {
    for (const components of [null, [], ['Design'], ['docs-site']]) {
      const r = narrowByTicketComponents({
        baseRepos: [repo('backend')],
        components,
        workspaceRepoNames: workspaceNames,
        scopingEnabled: true,
      });
      expect(r.kind).toBe('resolved');
      if (r.kind !== 'resolved') throw new Error('unreachable');
      expect(r.repos.map((x) => x.name)).toEqual(['backend']);
      expect(r.decision.gate).toBe('skipped_single_repo');
    }
  });

  it('row 2: empty base set (repo-less) also skips — nothing to gate', () => {
    const r = narrowByTicketComponents({
      baseRepos: [],
      components: [],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.repos).toEqual([]);
    expect(r.decision.gate).toBe('skipped_single_repo');
  });

  it('row 3: components unreadable (null) under an active gate ⇒ components_unreadable (R5)', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: null,
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('components_unreadable');
    if (r.kind !== 'components_unreadable') throw new Error('unreachable');
    expect(r.decision.gate).toBe('failed:components_unreadable');
  });

  it('row 4: no components ⇒ undeterminable case no_components (D2 case 1)', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: [],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('undeterminable');
    if (r.kind !== 'undeterminable') throw new Error('unreachable');
    expect(r.case).toBe('no_components');
    expect(r.decision.gate).toBe('parked:no_components');
    expect(r.decision.matched).toEqual([]);
  });

  it('row 5: components present but none names ANY workspace repo ⇒ no_repo_components (D2 case 2)', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: ['Design', 'QA', 'Documentation'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('undeterminable');
    if (r.kind !== 'undeterminable') throw new Error('unreachable');
    expect(r.case).toBe('no_repo_components');
    expect(r.decision.ignored).toEqual(['Design', 'QA', 'Documentation']);
    expect(r.decision.matched).toEqual([]);
  });

  it('row 6: components name workspace repos, but none inside the agent scope ⇒ outside_agent_scope (D2 case 3, routing defect)', () => {
    const r = narrowByTicketComponents({
      baseRepos: [repo('backend'), repo('infra')],
      components: ['docs-site', 'frontend'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('undeterminable');
    if (r.kind !== 'undeterminable') throw new Error('unreachable');
    expect(r.case).toBe('outside_agent_scope');
    // Both names DID match workspace repos — that is what distinguishes case 3 from case 2.
    expect(r.decision.matched).toEqual(['docs-site', 'frontend']);
    expect(r.decision.effective).toEqual([]);
  });

  it('row 7: components naming a subset ⇒ resolved to exactly that subset (D1)', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: ['backend'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.repos.map((x) => x.name)).toEqual(['backend']);
    expect(r.decision).toEqual({
      components: ['backend'],
      matched: ['backend'],
      ignored: [],
      effective: ['backend'],
      gate: 'passed',
    });
  });

  it('row 8: non-repo names filter silently while others match (D3 — never an error)', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: ['backend', 'Design'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.repos.map((x) => x.name)).toEqual(['backend']);
    expect(r.decision.matched).toEqual(['backend']);
    expect(r.decision.ignored).toEqual(['Design']);
  });

  it('row 9: components ⊃ agent scope never widen — intersection only (D1)', () => {
    const r = narrowByTicketComponents({
      baseRepos: [repo('frontend')], // single-element would skip; use two to keep the gate armed
      components: ['frontend', 'backend'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    // Single-repo base set: D2a wins first — still never widens.
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.repos.map((x) => x.name)).toEqual(['frontend']);

    const r2 = narrowByTicketComponents({
      baseRepos: [repo('frontend'), repo('infra')],
      components: ['frontend', 'backend', 'docs-site'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r2.kind).toBe('resolved');
    if (r2.kind !== 'resolved') throw new Error('unreachable');
    expect(r2.repos.map((x) => x.name)).toEqual(['frontend']);
    expect(r2.decision.effective).toEqual(['frontend']);
  });

  it('row 10: matching is exact on trimmed names, case-insensitive; duplicates collapse (FR-016)', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: [' Backend ', 'BACKEND', 'Frontend'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    // Effective preserves base-set declaration order and holds canonical repo names, deduped.
    expect(r.repos.map((x) => x.name)).toEqual(['backend', 'frontend']);
    expect(r.decision.effective).toEqual(['backend', 'frontend']);
  });

  it('resolved repos preserve base-set (workspace declaration) order, not component order', () => {
    const r = narrowByTicketComponents({
      baseRepos: base,
      components: ['infra', 'backend'],
      workspaceRepoNames: workspaceNames,
      scopingEnabled: true,
    });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.repos.map((x) => x.name)).toEqual(['backend', 'infra']);
  });
});

describe('composeScopeQuestion (D2 — three distinct, display-safe question texts)', () => {
  const display = {
    ticketKey: 'BRIG-7',
    components: ['Design'],
    agentRepoNames: ['backend', 'frontend'],
    workspaceRepoNames: ['backend', 'frontend', 'infra'],
  };

  it('produces a distinct title per case, each naming the ticket', () => {
    const titles = (['no_components', 'no_repo_components', 'outside_agent_scope'] as const).map(
      (scopeCase) => composeScopeQuestion(scopeCase, display).title,
    );
    expect(new Set(titles).size).toBe(3);
    for (const t of titles) expect(t).toContain('BRIG-7');
  });

  it('case 1 asks to set Components and lists the valid repository choices', () => {
    const q = composeScopeQuestion('no_components', display);
    expect(q.title).toBe('Set Components on BRIG-7 so the agent knows which repositories to work in');
    expect(q.details).toContain('backend');
    expect(q.details).toContain('frontend');
  });

  it('case 2 says nothing mapped and lists the components seen + matching repo names', () => {
    const q = composeScopeQuestion('no_repo_components', display);
    expect(q.title).toBe("None of BRIG-7's components map to a repository — add the repository component");
    expect(q.details).toContain('Design');
    expect(q.details).toContain('backend');
  });

  it('case 3 flags the routing mismatch between ticket repos and agent scope', () => {
    const q = composeScopeQuestion('outside_agent_scope', {
      ...display,
      components: ['infra'],
    });
    expect(q.title).toBe(
      'BRIG-7 targets repositories this agent is not configured for — check routing or the agent\'s scope',
    );
    expect(q.details).toContain('infra');
    expect(q.details).toContain('backend');
  });
});

describe('RepositoryScopeUndeterminableError', () => {
  it('carries the case and display-safe fields', () => {
    const err = new RepositoryScopeUndeterminableError(
      'no_components',
      { ticketKey: 'BRIG-1', components: [], agentRepoNames: ['a'], workspaceRepoNames: ['a', 'b'] },
      { components: [], matched: [], ignored: [], effective: [], gate: 'parked:no_components' },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.scopeCase).toBe('no_components');
    expect(err.display.ticketKey).toBe('BRIG-1');
    expect(err.decision.gate).toBe('parked:no_components');
    expect(err.message).toContain('BRIG-1');
  });
});
