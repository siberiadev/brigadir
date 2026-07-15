import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleRunList, sampleRunListItem, sampleRunningListItem } from './handlers';
import Runs from '../src/views/Runs.vue';

/**
 * T046 — Runs table (US3). Filters narrow the rows and the request carries them;
 * pagination reflects the filtered total; the cost-period switch re-queries the
 * total; a row click routes to the run card.
 */

function mountRuns() {
  return mountWithProviders(Runs, { props: { id: 'ws-1' } });
}

describe('Runs — table + filters + cost', () => {
  it('renders rows and the cost header from the faked endpoints', async () => {
    const wrapper = mountRuns();
    await flush();

    expect(wrapper.find('[data-test="runs-table"]').text()).toContain('Implementer');
    expect(wrapper.find('[data-test="runs-table"]').text()).toContain('BRIG-1');
    // Display rounds numeric(10,4) to 2 decimals: "1.2345" → "$1.23".
    expect(wrapper.find('[data-test="cost-total"]').text()).toContain('$1.23');
    expect(wrapper.find('[data-test="cost-total"]').text()).not.toContain('1.2345');
  });

  it('sends the status filter to the runs endpoint and narrows the rows', async () => {
    let lastStatus: string | null = null;
    server.use(
      http.get('/api/workspaces/:id/runs', ({ request }) => {
        lastStatus = new URL(request.url).searchParams.get('status');
        const items = lastStatus
          ? sampleRunList.items.filter((r) => r.status === lastStatus)
          : sampleRunList.items;
        return HttpResponse.json({ ...sampleRunList, items, total: items.length });
      }),
    );

    const wrapper = mountRuns();
    await flush();

    // Filter to a status no row has → empty result.
    await wrapper.findAllComponents({ name: 'ElSelect' })
      .find((s) => s.attributes('data-test') === 'filter-status')!
      .setValue('running');
    await flush();

    expect(lastStatus).toBe('running');
    expect(wrapper.find('[data-test="runs-empty"]').exists()).toBe(true);
  });

  it('switching the cost period re-queries the total', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/workspaces/:id/runs/cost', ({ request }) => {
        const period = new URL(request.url).searchParams.get('period') ?? '7d';
        seen.push(period);
        return HttpResponse.json({ period, total_cost_usd: period === '24h' ? '0.5' : '1.2345', run_count: 3 });
      }),
    );

    const wrapper = mountRuns();
    await flush();

    await wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', '24h');
    await flush();

    expect(seen).toContain('24h');
    expect(wrapper.find('[data-test="cost-total"]').text()).toContain('$0.50');
  });

  it('a running row pulses and ticks Duration live from started_at', async () => {
    server.use(
      http.get('/api/workspaces/:id/runs', () =>
        HttpResponse.json({
          ...sampleRunList,
          items: [
            // Started ~90 s ago; the stale server duration_ms (5 s) must lose.
            { ...sampleRunningListItem, started_at: new Date(Date.now() - 90_000).toISOString() },
            sampleRunListItem,
          ],
          total: 2,
        }),
      ),
    );

    const wrapper = mountRuns();
    await flush();

    const table = wrapper.find('[data-test="runs-table"]');
    // The pulse dot marks the running row only.
    expect(wrapper.findAll('[data-test="status-pulse"]')).toHaveLength(1);
    // Duration is computed from started_at (~1m 30s), not duration_ms (5s)…
    const before = table.text().match(/1m \d+s/)?.[0];
    expect(before).toBeTruthy();
    // …while the terminal row keeps its server-computed duration_ms.
    expect(table.text()).toContain('42s');

    // The useNow 1 s clock ticks the label forward (real timers — flush is timer-based).
    await flush(1100);
    expect(table.text().match(/1m \d+s/)?.[0]).not.toBe(before);
  });

  it('a row click routes to the run card', async () => {
    const wrapper = mountRuns();
    await flush();

    await wrapper.findComponent({ name: 'ElTable' }).vm.$emit('row-click', sampleRunListItem);
    await flush();

    const router = wrapper.vm.$router;
    expect(router.currentRoute.value.fullPath).toBe(`/runs/${sampleRunListItem.run_id}`);
  });
});
