import { describe, it, expect, afterEach } from 'vitest';
import { ChannelProbe, ALERT_THRESHOLD } from './channel-probe';

/**
 * Feature 026 (US4) — pre-flight probe backoff/counter/URL logic (pure; no
 * HTTP or DB). The dead-channel HTTP path + channel_down persistence are
 * covered by the integration suite.
 */
describe('channel probe backoff (feature 026, US4)', () => {
  afterEach(() => {
    delete process.env.BRIGADIR_CALLBACK_BASE_URL;
    delete process.env.BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS;
    delete process.env.BRIGADIR_CHANNEL_PROBE_MAX_TTL_MS;
  });

  it('ttlFor doubles from 30s and caps at 5min', () => {
    const p = new ChannelProbe();
    expect(p.ttlFor(1)).toBe(30_000);
    expect(p.ttlFor(2)).toBe(60_000);
    expect(p.ttlFor(3)).toBe(120_000);
    expect(p.ttlFor(4)).toBe(240_000);
    // 30s·2^4 = 480s > 300s cap.
    expect(p.ttlFor(5)).toBe(300_000);
    expect(p.ttlFor(9)).toBe(300_000);
  });

  it('ttlFor honors the env overrides (test-speed holds)', () => {
    process.env.BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS = '500';
    process.env.BRIGADIR_CHANNEL_PROBE_MAX_TTL_MS = '1500';
    const p = new ChannelProbe();
    expect(p.ttlFor(1)).toBe(500);
    expect(p.ttlFor(2)).toBe(1000);
    expect(p.ttlFor(3)).toBe(1500); // capped
  });

  it('recordSuccess resets a run so the next failure ladder restarts at 1', async () => {
    process.env.BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS = '100';
    const p = new ChannelProbe();
    const captured: Array<{ type: string; payload: unknown }> = [];
    const fakeDb = {
      insert: () => ({ values: async (row: { type: string; payload: unknown }) => void captured.push(row) }),
    } as unknown as Parameters<ChannelProbe['recordFailure']>[0];
    const fakeLogger = { warn: () => {}, error: () => {} } as unknown as Parameters<ChannelProbe['recordFailure']>[2];

    const ttl1 = await p.recordFailure(fakeDb, 'run-x', fakeLogger);
    const ttl2 = await p.recordFailure(fakeDb, 'run-x', fakeLogger);
    expect(ttl1).toBe(100); // consecutive 1
    expect(ttl2).toBe(200); // consecutive 2
    p.recordSuccess('run-x');
    const ttl3 = await p.recordFailure(fakeDb, 'run-x', fakeLogger);
    expect(ttl3).toBe(100); // ladder restarted

    // Each failure persisted a channel_down event with the growing count.
    expect(captured.map((c) => c.type)).toEqual(['channel_down', 'channel_down', 'channel_down']);
    expect((captured[1].payload as { consecutive: number }).consecutive).toBe(2);
  });

  it('alerts (error log) only at/after the threshold of consecutive failures', async () => {
    process.env.BRIGADIR_CHANNEL_PROBE_BASE_TTL_MS = '1';
    const p = new ChannelProbe();
    const fakeDb = {
      insert: () => ({ values: async () => {} }),
    } as unknown as Parameters<ChannelProbe['recordFailure']>[0];
    let warns = 0;
    let errors = 0;
    const fakeLogger = { warn: () => warns++, error: () => errors++ } as unknown as Parameters<
      ChannelProbe['recordFailure']
    >[2];

    for (let i = 0; i < ALERT_THRESHOLD; i++) await p.recordFailure(fakeDb, 'run-y', fakeLogger);
    expect(warns).toBe(ALERT_THRESHOLD - 1);
    expect(errors).toBe(1); // only the threshold-th failure alerts
  });

  it('healthUrl derives from BRIGADIR_CALLBACK_BASE_URL (and its default)', () => {
    const p = new ChannelProbe();
    expect(p.healthUrl()).toBe('http://127.0.0.1:3000/api/callbacks/health');
    process.env.BRIGADIR_CALLBACK_BASE_URL = 'http://example.test:9999/api/callbacks/';
    expect(p.healthUrl()).toBe('http://example.test:9999/api/callbacks/health');
  });
});
