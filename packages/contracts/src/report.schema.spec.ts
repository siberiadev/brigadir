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
});
