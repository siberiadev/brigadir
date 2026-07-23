import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';
import MetricsOverview from '../src/components/Metrics/MetricsOverview.vue';

/**
 * Feature 029 — the Overview panel (US1). The network is faked at the msw
 * boundary; the panel renders the five summary cards, shows explicit zeros/
 * dashes on an idle period, and refetches when the period filter changes.
 */

const sample = {
  period: '7d',
  total_cost_usd: '12.5000',
  run_count_by_status: {
    queued: 1,
    running: 2,
    awaiting_human: 0,
    succeeded: 8,
    failed: 1,
    cancelled: 0,
    timed_out: 0,
    superseded: 0,
  },
  success_rate: 0.8,
  median_duration_s: 45,
  open_human_tasks: 3,
};

const idle = {
  period: '7d',
  total_cost_usd: '0',
  run_count_by_status: {
    queued: 0,
    running: 0,
    awaiting_human: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    timed_out: 0,
    superseded: 0,
  },
  success_rate: null,
  median_duration_s: null,
  open_human_tasks: 0,
};

async function mountOverview(filters = { period: '7d' as const }) {
  const wrapper = mountWithProviders(MetricsOverview, { props: { filters } });
  await flush(20);
  return wrapper;
}

describe('MetricsOverview (US1)', () => {
  it('renders the five summary cards from the overview response', async () => {
    server.use(http.get('/api/metrics/overview', () => HttpResponse.json(sample)));
    const wrapper = await mountOverview();

    expect(wrapper.find('[data-test="ov-cost"]').text()).toContain('$12.50');
    expect(wrapper.find('[data-test="ov-runs"]').text()).toContain('12'); // total = sum
    expect(wrapper.find('[data-test="ov-status-succeeded"]').text()).toContain('8');
    expect(wrapper.find('[data-test="ov-success"]').text()).toContain('80.0%');
    expect(wrapper.find('[data-test="ov-median"]').text()).toContain('45s');
    expect(wrapper.find('[data-test="ov-human"]').text()).toContain('3');
  });

  it('shows explicit zeros/dashes on an idle period (no empty-state)', async () => {
    server.use(http.get('/api/metrics/overview', () => HttpResponse.json(idle)));
    const wrapper = await mountOverview();

    expect(wrapper.find('[data-test="ov-success"]').text()).toContain('—');
    expect(wrapper.find('[data-test="ov-median"]').text()).toContain('—');
    expect(wrapper.find('[data-test="ov-runs"]').text()).toContain('нет прогонов');
    expect(wrapper.find('[data-test="ov-human"]').text()).toContain('0');
  });

  it('refetches when the period filter changes', async () => {
    const periods: string[] = [];
    server.use(
      http.get('/api/metrics/overview', ({ request }) => {
        periods.push(new URL(request.url).searchParams.get('period') ?? '');
        return HttpResponse.json(sample);
      }),
    );
    const wrapper = await mountOverview({ period: '7d' as const });
    expect(periods).toContain('7d');

    await wrapper.setProps({ filters: { period: '30d' as const } });
    await flush(20);
    expect(periods).toContain('30d');
  });
});
