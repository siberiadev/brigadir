import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';

vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', props: ['option'], template: '<div class="vchart-stub" />' },
}));

import MetricsHuman from '../src/components/Metrics/MetricsHuman.vue';

const days = ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'];
const tb = (series: { key: string; points: (number | string)[] }[]) => ({
  granularity: 'day' as const,
  buckets: days,
  series,
});

const sample = {
  latency_median_s: tb([{ key: 'latency_median_s', points: [7200, 3600] }]),
  latency_p95_s: tb([{ key: 'latency_p95_s', points: [14400, 7200] }]),
  opened_by_kind: tb([{ key: 'question', points: [1, 2] }]),
  closed_by_kind: tb([{ key: 'question', points: [1, 0] }]),
  awaiting_human_share: tb([{ key: 'awaiting_human_share', points: [0.33, 0.5] }]),
};

describe('MetricsHuman (US5)', () => {
  it('renders the four human charts and the current-status caveat', async () => {
    server.use(http.get('/api/metrics/human', () => HttpResponse.json(sample)));
    const wrapper = mountWithProviders(MetricsHuman, { props: { filters: { period: '7d' } } });
    await flush(20);
    expect(wrapper.findAll('[data-test="chart-card"]').length).toBe(4);
    expect(wrapper.findAll('.vchart-stub').length).toBe(4);
    // The awaiting-human share carries the "current status" approximation note.
    expect(wrapper.find('[data-test="share-note"]').exists()).toBe(true);
  });
});
