import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';

// ECharts needs a real canvas 2D context (absent in jsdom); stub the renderer
// so the panel's structure/state logic is what's under test, not chart drawing.
vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', props: ['option'], template: '<div class="vchart-stub" />' },
}));

import MetricsCost from '../src/components/Metrics/MetricsCost.vue';

const days = ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'];
const tb = (series: { key: string; points: (number | string)[] }[]) => ({
  granularity: 'day' as const,
  buckets: days,
  series,
});

const sampleCost = {
  cost_by_executor: tb([
    { key: 'mock', points: ['1.0000', '2.0000'] },
    { key: 'kimi', points: ['0', '1.0000'] },
  ]),
  tokens_by_type: tb([
    { key: 'input', points: [100, 200] },
    { key: 'output', points: [50, 100] },
    { key: 'cache_read', points: [0, 0] },
    { key: 'cache_creation', points: [0, 0] },
  ]),
  tokens_by_executor: tb([
    { key: 'mock', points: [150, 300] },
    { key: 'kimi', points: [0, 100] },
  ]),
  tokens_by_model: tb([
    { key: 'claude-sonnet-5', points: [150, 300] },
    { key: '__unknown__', points: [0, 100] },
  ]),
  cost_per_run: tb([{ key: 'cost_per_run', points: ['0.5000', '0.5000'] }]),
  top_workspaces_by_cost: [{ workspace_id: 'w-1', name: 'Payments', total_cost_usd: '3.0000' }],
};

async function mountCost(filters: { period: '7d'; workspace_id?: string } = { period: '7d' }) {
  server.use(http.get('/api/metrics/cost', () => HttpResponse.json(sampleCost)));
  const wrapper = mountWithProviders(MetricsCost, { props: { filters } });
  await flush(20);
  return wrapper;
}

describe('MetricsCost (US2)', () => {
  it('renders the cost charts (incl. tokens-by-executor) and the indicative marker for kimi', async () => {
    const wrapper = await mountCost();
    // 3 generic cards + the two distinctly-tagged cards (tokens-by-executor,
    // top-workspaces) = 5 charts.
    expect(wrapper.findAll('[data-test="chart-card"]').length).toBe(3);
    expect(wrapper.find('[data-test="tokens-by-executor"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="tokens-by-model"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="top-workspaces"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="cost-indicative"]').exists()).toBe(true);
  });

  it('hides the top-workspaces chart when a single workspace is selected (US2 AS3)', async () => {
    const wrapper = await mountCost({
      period: '7d',
      workspace_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(wrapper.find('[data-test="top-workspaces"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="chart-card"]').length).toBe(3);
  });
});
