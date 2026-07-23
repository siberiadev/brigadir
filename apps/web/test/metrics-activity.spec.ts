import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';

vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', props: ['option'], template: '<div class="vchart-stub" />' },
}));

import MetricsActivity from '../src/components/Metrics/MetricsActivity.vue';

const days = ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'];
const tb = (series: { key: string; label?: string; points: (number | string)[] }[]) => ({
  granularity: 'day' as const,
  buckets: days,
  series,
});

const sample = {
  by_source: tb([
    { key: 'manual', points: [1, 2] },
    { key: '__unknown__', points: [0, 1] },
  ]),
  by_role: tb([{ key: 'Developer', points: [2, 1] }]),
  by_workspace: tb([{ key: 'w-1', label: 'Payments', points: [3, 3] }]),
};

describe('MetricsActivity (US4)', () => {
  it('renders the three activity breakdown charts', async () => {
    server.use(http.get('/api/metrics/activity', () => HttpResponse.json(sample)));
    const wrapper = mountWithProviders(MetricsActivity, { props: { filters: { period: '7d' } } });
    await flush(20);
    expect(wrapper.findAll('[data-test="chart-card"]').length).toBe(3);
    expect(wrapper.findAll('.vchart-stub').length).toBe(3);
  });

  it('shows empty states for empty breakdowns', async () => {
    server.use(
      http.get('/api/metrics/activity', () =>
        HttpResponse.json({ by_source: tb([]), by_role: tb([]), by_workspace: tb([]) }),
      ),
    );
    const wrapper = mountWithProviders(MetricsActivity, { props: { filters: { period: '7d' } } });
    await flush(20);
    expect(wrapper.findAll('[data-test="chart-empty"]').length).toBe(3);
  });
});
