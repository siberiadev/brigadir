import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';
import { routes } from '../src/router';

vi.mock('vue-echarts', () => ({
  default: { name: 'VChart', props: ['option'], template: '<div class="vchart-stub" />' },
}));

const days = ['2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z'];
const emptyTb = { granularity: 'day', buckets: days, series: [] };
const idleOverview = {
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
const emptyCost = {
  cost_by_executor: emptyTb,
  tokens_by_type: emptyTb,
  tokens_by_executor: emptyTb,
  tokens_by_model: emptyTb,
  cost_per_run: emptyTb,
  top_workspaces_by_cost: [],
};
const emptyHuman = {
  latency_median_s: emptyTb,
  latency_p95_s: emptyTb,
  opened_by_kind: emptyTb,
  closed_by_kind: emptyTb,
  awaiting_human_share: emptyTb,
};

function useMetricsHandlers(onCost?: (url: URL) => void) {
  server.use(
    http.get('/api/metrics/overview', () => HttpResponse.json(idleOverview)),
    http.get('/api/metrics/cost', ({ request }) => {
      onCost?.(new URL(request.url));
      return HttpResponse.json(emptyCost);
    }),
    http.get('/api/metrics/human', () => HttpResponse.json(emptyHuman)),
  );
}

async function tick(times = 40) {
  for (let i = 0; i < times; i++) await flush(5);
  await flush();
}

async function mountPage(initialPath: string) {
  const wrapper = mountWithProviders(
    (await import('../src/views/MetricsPage.vue')).default,
    { routes, initialPath },
  );
  await wrapper.vm.$router.isReady();
  await flush(30);
  return wrapper;
}

/** Flush until `predicate` holds, bounded (lazy pane + query settle). */
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await flush(5);
  await flush();
}

describe('MetricsPage (feature 029)', () => {
  it('seeds tab + filters from the URL and threads them to the request (R11)', async () => {
    let costUrl: URL | undefined;
    useMetricsHandlers((u) => (costUrl = u));
    const wrapper = await mountPage(
      '/metrics?tab=cost&period=30d&workspace=11111111-1111-4111-8111-111111111111&executor=kimi',
    );
    await settle(() => costUrl !== undefined);

    // The URL-seeded filters reach the cost request; the cost panel is active.
    expect(costUrl?.searchParams.get('period')).toBe('30d');
    expect(costUrl?.searchParams.get('workspace_id')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(costUrl?.searchParams.get('executor_type')).toBe('kimi');
    expect(wrapper.find('[data-test="metrics-cost"]').exists()).toBe(true);
  });

  it('disables the executor picker on the Human tab (H1/FR-011a)', async () => {
    useMetricsHandlers();
    const wrapper = await mountPage('/metrics?tab=human');
    await settle(() => wrapper.find('[data-test="metrics-human"]').exists());
    expect(wrapper.find('[data-test="metrics-human"]').exists()).toBe(true);
    // Element Plus reflects the disabled state on the inner input.
    const execInput = wrapper.find('[data-test="filter-executor"] input');
    expect(execInput.attributes('disabled')).toBeDefined();
  });

  it('opens on Overview and defers other tabs until first opened (lazy, FR-004)', async () => {
    let costFired = false;
    useMetricsHandlers(() => (costFired = true));
    const wrapper = await mountPage('/metrics');
    await tick();
    // Overview is the active default; the cost tab was never opened, so its
    // request never fired (lazy mount).
    expect(wrapper.find('[data-test="metrics-overview"]').exists()).toBe(true);
    expect(costFired).toBe(false);
  });
});
