import { describe, it, expect } from 'vitest';
import {
  ReportProgressSchema,
  RequestHumanSchema,
  CompleteTaskSchema,
} from './callback-tools.schema';

describe('CallbackTools schemas', () => {
  it('report_progress accepts a valid payload and rejects a malformed one', () => {
    expect(
      ReportProgressSchema.safeParse({ stage: 'implementing', message: 'wrote service' })
        .success,
    ).toBe(true);
    expect(
      ReportProgressSchema.safeParse({ stage: 'x', message: 'y', percent: 150 }).success,
    ).toBe(false);
  });

  it('request_human accepts a valid payload and defaults blocking=true', () => {
    const res = RequestHumanSchema.safeParse({
      kind: 'blocker',
      title: 'Need repo access',
      details: 'The clone failed with 403.',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.blocking).toBe(true);
  });

  it('request_human rejects an unknown kind', () => {
    expect(
      RequestHumanSchema.safeParse({ kind: 'nope', title: 't', details: 'd' }).success,
    ).toBe(false);
  });

  it('complete_task equals ReportSchema (accepts a valid report)', () => {
    expect(
      CompleteTaskSchema.safeParse({
        schema_version: 1,
        outcome: 'success',
        summary: 'done',
        checks: [],
      }).success,
    ).toBe(true);
  });
});
