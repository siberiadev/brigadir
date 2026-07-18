import { describe, it, expect } from 'vitest';
import { ReportSchema, normalizeReportArtifacts } from './report.schema';

const baseSuccess = {
  schema_version: 1 as const,
  outcome: 'success' as const,
  summary: 'Implemented the ticket and ran tests.',
  checks: [
    { name: 'tests_pass', status: 'pass' as const },
    { name: 'lint_pass', status: 'pass' as const, reason: 'no warnings' },
  ],
};

describe('ReportSchema v1', () => {
  it('accepts a valid success report', () => {
    expect(ReportSchema.safeParse(baseSuccess).success).toBe(true);
  });

  it('accepts a valid failure report with a failing check', () => {
    const r = {
      ...baseSuccess,
      outcome: 'failure' as const,
      checks: [{ name: 'tests_pass', status: 'fail' as const, reason: '3 failing' }],
    };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('accepts needs_human when human_task is present', () => {
    const r = {
      ...baseSuccess,
      outcome: 'needs_human' as const,
      human_task: { kind: 'question' as const, title: 'Which API base URL?' },
    };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('rejects needs_human without human_task (Constitution IV)', () => {
    const r = { ...baseSuccess, outcome: 'needs_human' as const };
    const res = ReportSchema.safeParse(r);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'human_task')).toBe(true);
    }
  });

  // feature 013: suggested answer options on the needs_human ask surface.
  it('accepts needs_human whose human_task carries answer options', () => {
    const r = {
      ...baseSuccess,
      outcome: 'needs_human' as const,
      human_task: {
        kind: 'question' as const,
        title: 'Which API base URL?',
        options: [
          { label: 'Staging', value: 'https://staging.example.com' },
          { label: 'Production', description: 'Only if the ticket says so' },
        ],
      },
    };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('rejects out-of-bounds human_task.options (6 items / empty array / extra key)', () => {
    const withOptions = (options: unknown) => ({
      ...baseSuccess,
      outcome: 'needs_human' as const,
      human_task: { kind: 'question' as const, title: 't', options },
    });
    expect(
      ReportSchema.safeParse(
        withOptions(Array.from({ length: 6 }, (_, i) => ({ label: `o${i}` }))),
      ).success,
    ).toBe(false);
    expect(ReportSchema.safeParse(withOptions([])).success).toBe(false);
    expect(ReportSchema.safeParse(withOptions([{ label: 'x', icon: 'y' }])).success).toBe(false);
  });

  it('rejects unknown top-level properties (additionalProperties:false)', () => {
    const r = { ...baseSuccess, human_needed: true };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it('rejects more than 50 checks', () => {
    const r = {
      ...baseSuccess,
      checks: Array.from({ length: 51 }, (_, i) => ({
        name: `c${i}`,
        status: 'pass' as const,
      })),
    };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it('accepts schema_version 2 (feature 019 — v1|v2 union)', () => {
    const r = { ...baseSuccess, schema_version: 2 };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('rejects an unknown schema_version', () => {
    const r = { ...baseSuccess, schema_version: 3 };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  describe('routed outcome (feature 010, FR-001)', () => {
    it('accepts routed when routing is present', () => {
      const r = {
        ...baseSuccess,
        outcome: 'routed' as const,
        routing: { target_agent: 'Developer', task: 'Fix the failing lint step.' },
      };
      expect(ReportSchema.safeParse(r).success).toBe(true);
    });

    it('rejects routed without routing (mirrors needs_human rule)', () => {
      const r = { ...baseSuccess, outcome: 'routed' as const };
      const res = ReportSchema.safeParse(r);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues.some((i) => i.path.join('.') === 'routing')).toBe(true);
      }
    });

    it('rejects routing.target_agent > 200 chars', () => {
      const r = {
        ...baseSuccess,
        outcome: 'routed' as const,
        routing: { target_agent: 'a'.repeat(201), task: 'x' },
      };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });

    it('rejects routing.task > 4000 chars', () => {
      const r = {
        ...baseSuccess,
        outcome: 'routed' as const,
        routing: { target_agent: 'Developer', task: 'a'.repeat(4001) },
      };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });

    it('rejects unknown keys inside routing (.strict())', () => {
      const r = {
        ...baseSuccess,
        outcome: 'routed' as const,
        routing: { target_agent: 'Developer', task: 'x', priority: 'high' },
      };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });
  });

  describe('team outcome (feature 011, FR-013)', () => {
    const teamAgent = {
      name: 'Developer',
      description: 'Implements tickets end to end.',
      instruction: 'You implement the ticket. Open a PR.',
      trigger_status: 'To Do',
      status_running: 'In Progress',
      status_success: 'In Review',
      status_failure: 'Blocked',
      executor: 'claude-default',
    };

    it('accepts team when the payload is present', () => {
      const r = {
        ...baseSuccess,
        outcome: 'team' as const,
        team: { agents: [teamAgent] },
      };
      expect(ReportSchema.safeParse(r).success).toBe(true);
    });

    it('rejects team without the payload (mirrors routed/needs_human rule)', () => {
      const r = { ...baseSuccess, outcome: 'team' as const };
      const res = ReportSchema.safeParse(r);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.path).toEqual(['team']);
      }
    });

    it('rejects a team payload on a non-team outcome', () => {
      const r = { ...baseSuccess, team: { agents: [teamAgent] } };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });

    it('rejects an empty agent list', () => {
      const r = { ...baseSuccess, outcome: 'team' as const, team: { agents: [] } };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });

    it('rejects more than 20 agents', () => {
      const r = {
        ...baseSuccess,
        outcome: 'team' as const,
        team: { agents: Array.from({ length: 21 }, (_, i) => ({ ...teamAgent, name: `A${i}` })) },
      };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });

    it('rejects unknown keys inside a team agent (.strict())', () => {
      const r = {
        ...baseSuccess,
        outcome: 'team' as const,
        team: { agents: [{ ...teamAgent, model: 'opus' }] },
      };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });

    it('rejects an oversized instruction (> 8000 chars)', () => {
      const r = {
        ...baseSuccess,
        outcome: 'team' as const,
        team: { agents: [{ ...teamAgent, instruction: 'x'.repeat(8001) }] },
      };
      expect(ReportSchema.safeParse(r).success).toBe(false);
    });
  });
});

// Feature 019: per-repository artifacts (ReportSchema v2). No version⇄field
// coupling — v1+flat, v1+repos, v2+flat, v2+repos all validate (research D2).
describe('ReportSchema v2 artifacts.repos', () => {
  const repoEntry = {
    repo: 'lib',
    branch: 'feat/T-1',
    pr_url: 'https://git.example.com/lib/pull/1',
    commits: ['abc123 contract change'],
    files_changed: 2,
  };

  it('accepts v2 with per-repo artifacts', () => {
    const r = {
      ...baseSuccess,
      schema_version: 2,
      artifacts: { repos: [repoEntry, { repo: 'consumer' }] },
    };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('accepts v1 with flat artifacts (legacy form stays valid)', () => {
    const r = {
      ...baseSuccess,
      artifacts: { branch: 'feat/T-1', pr_url: 'https://x', commits: ['abc'], files_changed: 3 },
    };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('accepts v1 with repos and v2 with flat (no version⇄field coupling)', () => {
    expect(
      ReportSchema.safeParse({ ...baseSuccess, artifacts: { repos: [repoEntry] } }).success,
    ).toBe(true);
    expect(
      ReportSchema.safeParse({ ...baseSuccess, schema_version: 2, artifacts: { branch: 'b' } })
        .success,
    ).toBe(true);
  });

  it('accepts both forms in one report (repos authoritative at consumption)', () => {
    const r = {
      ...baseSuccess,
      schema_version: 2,
      artifacts: { branch: 'feat/T-1', repos: [repoEntry] },
    };
    expect(ReportSchema.safeParse(r).success).toBe(true);
  });

  it('requires repo on each entry', () => {
    const r = { ...baseSuccess, artifacts: { repos: [{ branch: 'feat/T-1' }] } };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it('rejects unknown keys inside a repo entry (.strict())', () => {
    const r = { ...baseSuccess, artifacts: { repos: [{ ...repoEntry, pushed: true }] } };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });

  it('rejects more than 20 repo entries', () => {
    const r = {
      ...baseSuccess,
      artifacts: { repos: Array.from({ length: 21 }, (_, i) => ({ repo: `r${i}` })) },
    };
    expect(ReportSchema.safeParse(r).success).toBe(false);
  });
});

describe('normalizeReportArtifacts (feature 019 — the ONE precedence rule)', () => {
  it('returns repos[] verbatim when present, ignoring flat fields', () => {
    const out = normalizeReportArtifacts({
      artifacts: { branch: 'flat-b', pr_url: 'flat-p', repos: [{ repo: 'lib', branch: 'b1' }] },
    });
    expect(out).toEqual([{ repo: 'lib', branch: 'b1' }]);
  });

  it('an explicitly empty repos[] is authoritative (flat NOT resurrected)', () => {
    expect(normalizeReportArtifacts({ artifacts: { branch: 'flat-b', repos: [] } })).toEqual([]);
  });

  it('maps flat fields to a one-element list without a repo name', () => {
    const out = normalizeReportArtifacts({
      artifacts: { branch: 'b', pr_url: 'p', commits: ['c'], files_changed: 1 },
    });
    expect(out).toEqual([
      { repo: undefined, branch: 'b', pr_url: 'p', commits: ['c'], files_changed: 1 },
    ]);
  });

  it('returns [] for absent or empty artifacts', () => {
    expect(normalizeReportArtifacts({})).toEqual([]);
    expect(normalizeReportArtifacts({ artifacts: {} })).toEqual([]);
  });
});
