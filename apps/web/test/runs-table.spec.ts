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

  // Feature 025: a kimi run's cost carries the indicative marker in the list;
  // a claude_cli run does not. Regression guard — the list row must carry
  // `executor_type` (RunListItemSchema), or the marker silently never renders.
  it('marks a kimi run cost as indicative in the table; claude_cli has no marker', async () => {
    server.use(
      http.get('/api/workspaces/:id/runs', () =>
        HttpResponse.json({
          ...sampleRunList,
          items: [
            { ...sampleRunListItem, run_id: 'run-kimi', executor_type: 'kimi', cost_usd: '0.0500' },
            { ...sampleRunListItem, run_id: 'run-claude', executor_type: 'claude_cli' },
          ],
          total: 2,
        }),
      ),
    );
    const wrapper = mountRuns();
    await flush();

    const markers = wrapper.findAll('[data-test="cost-indicative"]');
    expect(markers.length).toBe(1);
  });

  it('shows the agent role per run, em dash when the agent has none (feature 016)', async () => {
    server.use(
      http.get('/api/workspaces/:id/runs', () =>
        HttpResponse.json({
          ...sampleRunList,
          // sampleRunningListItem.agent.role = 'developer'; sampleRunListItem's is null.
          items: [sampleRunningListItem, sampleRunListItem],
          total: 2,
        }),
      ),
    );

    const wrapper = mountRuns();
    await flush();

    const headers = wrapper.findAll('[data-test="runs-table"] th').map((th) => th.text());
    expect(headers).toContain('Role');
    const roleCol = headers.indexOf('Role');

    const rows = wrapper.findAll('[data-test="runs-table"] .el-table__row');
    expect(rows).toHaveLength(2);
    expect(rows[0].findAll('td')[roleCol].text()).toBe('developer');
    // Role-less agent → em dash (same fallback idiom as Cost).
    expect(rows[1].findAll('td')[roleCol].text()).toBe('—');
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

  it('Stop all runs fires cancel-all only after confirmation and reports the count', async () => {
    let cancelAllCalls = 0;
    server.use(
      http.post('/api/workspaces/:id/runs/cancel-all', () => {
        cancelAllCalls += 1;
        return HttpResponse.json({ ok: true, cancelled_count: 2 });
      }),
    );

    const wrapper = mountRuns();
    await flush();

    await wrapper.find('[data-test="stop-all-runs"]').trigger('click');
    await flush(5);
    // No request until the ElMessageBox confirm (renders into document.body;
    // pick the LAST box — earlier tests' boxes may still be transitioning out).
    expect(cancelAllCalls).toBe(0);
    const confirms = document.querySelectorAll<HTMLButtonElement>(
      '.el-message-box__btns .el-button--primary',
    );
    expect(confirms.length).toBeGreaterThan(0);
    confirms[confirms.length - 1].click();
    await flush(10);

    expect(cancelAllCalls).toBe(1);
    expect(document.body.textContent).toContain('Cancelled 2 runs.');
  });

  it('dismissing the Stop all confirmation sends nothing', async () => {
    let cancelAllCalls = 0;
    server.use(
      http.post('/api/workspaces/:id/runs/cancel-all', () => {
        cancelAllCalls += 1;
        return HttpResponse.json({ ok: true, cancelled_count: 0 });
      }),
    );

    const wrapper = mountRuns();
    await flush();

    await wrapper.find('[data-test="stop-all-runs"]').trigger('click');
    await flush(5);
    const dismissals = document.querySelectorAll<HTMLButtonElement>(
      '.el-message-box__btns .el-button:not(.el-button--primary)',
    );
    expect(dismissals.length).toBeGreaterThan(0);
    dismissals[dismissals.length - 1].click();
    await flush(10);

    expect(cancelAllCalls).toBe(0);
  });

  it('a row click routes to the run card', async () => {
    const wrapper = mountRuns();
    await flush();

    await wrapper.findComponent({ name: 'ElTable' }).vm.$emit('row-click', sampleRunListItem);
    await flush();

    const router = wrapper.vm.$router;
    expect(router.currentRoute.value.fullPath).toBe(`/runs/${sampleRunListItem.run_id}`);
  });

  // Отсчёт до следующего тика реконсайла + «Sync now» в шапке.
  it('shows the sync countdown and ticks it down with the 1 s clock', async () => {
    const wrapper = mountRuns();
    await flush();

    // Default handler serves next_run_at = now + 25 s.
    const before = wrapper.find('[data-test="sync-countdown"]').text();
    expect(before).toMatch(/Next sync in \d+s/);

    await flush(1100);
    expect(wrapper.find('[data-test="sync-countdown"]').text()).not.toBe(before);
  });

  it('shows "Sync schedule off" when the worker has not registered the scheduler', async () => {
    server.use(
      http.get('/api/reconcile/status', () =>
        HttpResponse.json({
          scheduled: false,
          every_ms: null,
          next_run_at: null,
          last_run_at: null,
          generated_at: new Date().toISOString(),
        }),
      ),
    );
    const wrapper = mountRuns();
    await flush();

    expect(wrapper.find('[data-test="sync-countdown"]').text()).toBe('Sync schedule off');
  });

  it('Sync now posts a manual trigger and toasts success', async () => {
    let triggerCalls = 0;
    server.use(
      http.post('/api/reconcile/trigger', () => {
        triggerCalls += 1;
        return HttpResponse.json({ ok: true, deduplicated: false });
      }),
    );
    const wrapper = mountRuns();
    await flush();

    await wrapper.find('[data-test="trigger-sync"]').trigger('click');
    await flush(10);

    expect(triggerCalls).toBe(1);
    expect(document.body.textContent).toContain('Sync started.');
  });

  it('a deduplicated trigger toasts "already queued" instead of success', async () => {
    server.use(
      http.post('/api/reconcile/trigger', () =>
        HttpResponse.json({ ok: true, deduplicated: true }),
      ),
    );
    const wrapper = mountRuns();
    await flush();

    await wrapper.find('[data-test="trigger-sync"]').trigger('click');
    await flush(10);

    expect(document.body.textContent).toContain('Sync already queued.');
  });

  // Feature 027 (FR-015): маркер недоставленных callbacks в ячейке статуса.
  it('shows the callback_alert marker only on flagged runs', async () => {
    server.use(
      http.get('/api/workspaces/:id/runs', () =>
        HttpResponse.json({
          ...sampleRunList,
          items: [
            { ...sampleRunListItem, run_id: 'run-alerted', callback_alert: true },
            { ...sampleRunListItem, run_id: 'run-clean' },
          ],
          total: 2,
        }),
      ),
    );
    const wrapper = mountRuns();
    await flush();

    expect(wrapper.find('[data-test="callback-alert-run-alerted"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="callback-alert-run-clean"]').exists()).toBe(false);
  });
});
