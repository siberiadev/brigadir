import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';

vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', props: ['option'], template: '<div class="vchart-stub" />' },
}));

import MetricsReliability from '../src/components/Metrics/MetricsReliability.vue';

const days = ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'];
const tb = (series: { key: string; points: (number | string)[] }[]) => ({
  granularity: 'day' as const,
  buckets: days,
  series,
});

const sample = {
  runs_by_status: tb([
    { key: 'succeeded', points: [3, 4] },
    { key: 'failed', points: [1, 0] },
  ]),
  success_rate: tb([{ key: 'success_rate', points: [0.75, 1] }]),
  duration_median_s: tb([{ key: 'duration_median_s', points: [20, 25] }]),
  duration_p95_s: tb([{ key: 'duration_p95_s', points: [40, 50] }]),
  retry_rate: tb([{ key: 'retry_rate', points: [0.1, 0] }]),
  failstats_by_executor: tb([{ key: 'mock', points: [1, 0] }]),
};

describe('MetricsReliability (US3)', () => {
  it('renders the five reliability charts', async () => {
    server.use(http.get('/api/metrics/reliability', () => HttpResponse.json(sample)));
    const wrapper = mountWithProviders(MetricsReliability, { props: { filters: { period: '7d' } } });
    await flush(20);
    expect(wrapper.findAll('[data-test="chart-card"]').length).toBe(5);
    // Data present → charts rendered (not empty state).
    expect(wrapper.findAll('.vchart-stub').length).toBe(5);
  });

  it('shows empty states when every series is zero', async () => {
    const zero = {
      runs_by_status: tb([]),
      success_rate: tb([{ key: 'success_rate', points: [0, 0] }]),
      duration_median_s: tb([{ key: 'duration_median_s', points: [0, 0] }]),
      duration_p95_s: tb([{ key: 'duration_p95_s', points: [0, 0] }]),
      retry_rate: tb([{ key: 'retry_rate', points: [0, 0] }]),
      failstats_by_executor: tb([]),
    };
    server.use(http.get('/api/metrics/reliability', () => HttpResponse.json(zero)));
    const wrapper = mountWithProviders(MetricsReliability, { props: { filters: { period: '7d' } } });
    await flush(20);
    expect(wrapper.findAll('[data-test="chart-empty"]').length).toBe(5);
  });
});
