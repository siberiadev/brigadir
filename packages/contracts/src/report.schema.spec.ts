import { describe, it, expect } from 'vitest';
import { ReportSchema } from './report.schema';

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

  it('rejects wrong schema_version', () => {
    const r = { ...baseSuccess, schema_version: 2 };
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
