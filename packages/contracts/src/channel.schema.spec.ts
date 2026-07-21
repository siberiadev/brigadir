import { describe, expect, it } from 'vitest';

import {
  CHANNEL_HEALTH_AFFECTED_RUNS_CAP,
  ChannelBreadcrumbRecordSchema,
  ChannelFailureEventPayloadSchema,
  ChannelHealthResponseSchema,
} from './channel.schema';

const validRecord = {
  ts: '2026-07-21T12:34:56.789Z',
  tool: 'report_progress',
  kind: 'network',
  attempts: 11,
  error: { name: 'TypeError', message: 'fetch failed' },
  target: '127.0.0.1:3210',
};

describe('ChannelBreadcrumbRecordSchema', () => {
  it('accepts a network-exhaustion record', () => {
    expect(ChannelBreadcrumbRecordSchema.parse(validRecord)).toMatchObject({
      kind: 'network',
      attempts: 11,
    });
  });

  it('accepts an http-exhaustion record with status', () => {
    const parsed = ChannelBreadcrumbRecordSchema.parse({
      ...validRecord,
      kind: 'http',
      attempts: 4,
      status: 502,
    });
    expect(parsed.status).toBe(502);
  });

  it('tolerates unknown additive keys (protocol forward-compat)', () => {
    expect(() =>
      ChannelBreadcrumbRecordSchema.parse({ ...validRecord, future_field: 'x' }),
    ).not.toThrow();
  });

  it('rejects records without a tool or with zero attempts', () => {
    expect(ChannelBreadcrumbRecordSchema.safeParse({ ...validRecord, tool: '' }).success).toBe(
      false,
    );
    expect(ChannelBreadcrumbRecordSchema.safeParse({ ...validRecord, attempts: 0 }).success).toBe(
      false,
    );
  });

  it('rejects unknown kind values', () => {
    expect(ChannelBreadcrumbRecordSchema.safeParse({ ...validRecord, kind: 'dns' }).success).toBe(
      false,
    );
  });
});

describe('ChannelFailureEventPayloadSchema', () => {
  it('requires occurred_at and a known source', () => {
    const payload = {
      ...validRecord,
      occurred_at: validRecord.ts,
      source: 'exit',
    };
    expect(ChannelFailureEventPayloadSchema.parse(payload).source).toBe('exit');
    expect(
      ChannelFailureEventPayloadSchema.safeParse({ ...payload, source: 'webhook' }).success,
    ).toBe(false);
    const { occurred_at: _dropped, ...withoutOccurredAt } = payload;
    expect(ChannelFailureEventPayloadSchema.safeParse(withoutOccurredAt).success).toBe(false);
  });
});

describe('ChannelHealthResponseSchema', () => {
  const healthy = {
    status: 'healthy',
    generated_at: '2026-07-21T17:20:00.000Z',
    window_ms: 900_000,
    failure_threshold: 3,
    last_successful_callback_at: null,
    channel_failures_in_window: 0,
    probe_failures_in_window: 0,
    deployment_guard: { ok: true, reason: null },
    affected_runs: [],
  };

  it('accepts a fresh-system healthy payload', () => {
    expect(ChannelHealthResponseSchema.parse(healthy).status).toBe('healthy');
  });

  it('accepts a degraded payload with affected runs', () => {
    const parsed = ChannelHealthResponseSchema.parse({
      ...healthy,
      status: 'degraded',
      probe_failures_in_window: 1,
      deployment_guard: { ok: false, reason: 'stale' },
      affected_runs: [
        {
          run_id: '3f60c1a1-0000-4000-8000-000000000000',
          ticket_key: 'BRG-42',
          last_event_at: '2026-07-21T17:18:03.000Z',
        },
      ],
    });
    expect(parsed.affected_runs).toHaveLength(1);
  });

  it('is strict: rejects unknown fields', () => {
    expect(ChannelHealthResponseSchema.safeParse({ ...healthy, extra: 1 }).success).toBe(false);
  });

  it('enforces the affected-runs cap', () => {
    const run = {
      run_id: '3f60c1a1-0000-4000-8000-000000000000',
      ticket_key: null,
      last_event_at: '2026-07-21T17:18:03.000Z',
    };
    const overCap = Array.from({ length: CHANNEL_HEALTH_AFFECTED_RUNS_CAP + 1 }, () => run);
    expect(
      ChannelHealthResponseSchema.safeParse({ ...healthy, affected_runs: overCap }).success,
    ).toBe(false);
  });
});
