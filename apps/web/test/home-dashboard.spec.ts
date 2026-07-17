import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';
import { routes } from '../src/router';
import {
  sampleGlobalRunsAttention,
  sampleGlobalRunsLive,
  sampleHomeSummary,
  sampleHomeWorkspaces,
  sampleHumanQueueOpen,
} from './handlers';
import HomeDashboard from '../src/views/HomeDashboard.vue';
// Warm the lazy route components so navigation assertions are deterministic.
import '../src/views/RunCard.vue';
import '../src/views/HumanQueue.vue';
import '../src/views/WorkspaceList.vue';
import '../src/views/WorkspacePage.vue';
import '../src/views/Runs.vue';

/**
 * Feature 017 — the /home dashboard blocks. The network is faked at the msw
 * boundary (never the query layer); navigation runs against the app's REAL
 * routes through the memory-history harness.
 */

async function mountHome() {
  const wrapper = mountWithProviders(HomeDashboard, { routes, initialPath: '/home' });
  const router = wrapper.vm.$router;
  await router.isReady();
  await flush(20);
  return { wrapper, router };
}

/** Flush until `predicate` holds, bounded (route commits, poll settles). */
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await flush(5);
  await flush();
}

describe('Home — stat tiles (US2)', () => {
  it('renders all four counters from the ONE summary response', async () => {
    const { wrapper } = await mountHome();

    expect(wrapper.find('[data-test="tile-running"]').text()).toContain('2');
    expect(wrapper.find('[data-test="tile-queued"]').text()).toContain('1');
    expect(wrapper.find('[data-test="tile-attention-value"]').text().trim()).toBe('2');
    expect(wrapper.find('[data-test="tile-attention-sub"]').text()).toContain('1 failed');
    expect(wrapper.find('[data-test="tile-attention-sub"]').text()).toContain('1 timed out');
    expect(wrapper.find('[data-test="tile-human"]').text()).toContain('2');
  });

  it('flags the attention tile with danger styling only when non-zero (FR-011)', async () => {
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="tile-attention-value"]').classes()).toContain('is-danger');
  });

  it('renders zeros (no danger flag) on an idle platform', async () => {
    server.use(
      http.get('/api/home/summary', () =>
        HttpResponse.json({
          running: 0,
          queued: 0,
          attention_24h: { failed: 0, timed_out: 0 },
          human_open: 0,
          spend: {
            '24h': { total_cost_usd: '0', run_count: 0 },
            '7d': { total_cost_usd: '0', run_count: 0 },
            '30d': { total_cost_usd: '0', run_count: 0 },
          },
        }),
      ),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="tile-running"]').text()).toContain('0');
    expect(wrapper.find('[data-test="tile-attention-value"]').classes()).not.toContain('is-danger');
  });

  it('the running tile carries the pulse state indicator', async () => {
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="tile-running"] .pulse-dot').exists()).toBe(true);
  });
});

describe('Home — human queue hero (US1)', () => {
  it('shows the count and the task rows with agent/workspace/waiting age', async () => {
    const { wrapper } = await mountHome();

    expect(wrapper.find('[data-test="hero-count"]').text()).toBe(
      String(sampleHumanQueueOpen.total),
    );
    const rows = wrapper.findAll('[data-test="hero-row"]');
    expect(rows.length).toBe(sampleHumanQueueOpen.items.length);
    expect(rows[0].text()).toContain('BRIG-1');
    expect(rows[0].text()).toContain('Which auth provider?');
    expect(rows[0].text()).toContain('Implementer');
    expect(rows[0].text()).toContain('Acme');
    expect(rows[0].find('[data-test="hero-wait"]').text()).toMatch(/waiting \d+[smhd]/);
  });

  it('a task row navigates to its blocked run card; runless tasks go to the queue', async () => {
    const { wrapper, router } = await mountHome();

    await wrapper.findAll('[data-test="hero-row"]')[0].trigger('click');
    await settle(() => router.currentRoute.value.path === '/runs/run-1');
    expect(router.currentRoute.value.name).toBe('run-card');

    await router.push('/home');
    await flush(20);
    // Second fixture task has run_id: null → falls back to the full queue.
    await wrapper.findAll('[data-test="hero-row"]')[1].trigger('click');
    await settle(() => router.currentRoute.value.path === '/human-queue');
    expect(router.currentRoute.value.path).toBe('/human-queue');
  });

  it('the header links to the full queue page', async () => {
    const { wrapper } = await mountHome();
    const link = wrapper.find('[data-test="hero-open-queue"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('/human-queue');
  });

  it('renders a positive empty state at zero pending tasks', async () => {
    server.use(
      http.get('/api/human-tasks', () =>
        HttpResponse.json({ items: [], page: 1, page_size: 5, total: 0 }),
      ),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="hero-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="hero-count"]').text()).toBe('0');
  });

  it('requests the open list OLDEST-first (order=oldest) — longest-waiting on top', async () => {
    // The queue page defaults to newest-first (feature 016); the hero opts in
    // to the 017 ordering explicitly.
    let capturedOrder: string | null = null;
    server.use(
      http.get('/api/human-tasks', ({ request }) => {
        capturedOrder = new URL(request.url).searchParams.get('order');
        return HttpResponse.json(sampleHumanQueueOpen);
      }),
    );
    await mountHome();
    expect(capturedOrder).toBe('oldest');
  });
});

describe('Home — needs attention list (US3)', () => {
  it('renders failed/timed_out rows with status tag, ticket, agent, workspace, finish age', async () => {
    const { wrapper } = await mountHome();

    const rows = wrapper.findAll('[data-test="attention-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].find('[data-test="run-status"]').text()).toContain('failed');
    expect(rows[0].text()).toContain('BRIG-8');
    expect(rows[0].text()).toContain('Implementer');
    expect(rows[0].text()).toContain('Acme');
    expect(rows[0].find('[data-test="attention-when"]').text()).toMatch(/\d+[smhd] ago/);
    // Ticketless setup run renders the label, not a blank.
    expect(rows[1].text()).toContain('Workspace setup');
    expect(wrapper.find('[data-test="attention-count"]').text()).toContain('2 in 24h');
  });

  it('a row opens the run card', async () => {
    const { wrapper, router } = await mountHome();
    await wrapper.findAll('[data-test="attention-row"]')[0].trigger('click');
    await settle(() => router.currentRoute.value.path === '/runs/run-att-1');
    expect(router.currentRoute.value.name).toBe('run-card');
  });

  it('shows an overflow note when total exceeds the rendered rows', async () => {
    server.use(
      http.get('/api/runs', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status') ?? '';
        if (status.includes('running')) return HttpResponse.json(sampleGlobalRunsLive);
        return HttpResponse.json({ ...sampleGlobalRunsAttention, total: 14 });
      }),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="attention-overflow"]').text()).toContain('showing 2 of 14');
  });

  it('renders a positive empty state when nothing broke', async () => {
    server.use(
      http.get('/api/runs', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status') ?? '';
        if (status.includes('running')) return HttpResponse.json(sampleGlobalRunsLive);
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="attention-empty"]').exists()).toBe(true);
  });
});

describe('Home — live runs (US4)', () => {
  it('renders running rows with tickers and queued rows with waiting age, server order kept', async () => {
    const { wrapper } = await mountHome();

    const rows = wrapper.findAll('[data-test="live-row"]');
    expect(rows.length).toBe(3);
    // Server ordering trusted: running rows first, queued last.
    expect(rows[0].find('[data-test="live-ticker"]').exists()).toBe(true);
    expect(rows[1].find('[data-test="live-ticker"]').exists()).toBe(true);
    expect(rows[2].find('[data-test="live-queued-age"]').text()).toMatch(/in queue \d+[smhd]/);
    expect(rows[0].text()).toContain('BRIG-10');
    expect(rows[1].text()).toContain('Checkout');
  });

  it('the running ticker advances every second without a refetch (FR-016)', async () => {
    let calls = 0;
    server.use(
      http.get('/api/runs', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status') ?? '';
        if (!status.includes('running')) return HttpResponse.json(sampleGlobalRunsAttention);
        calls += 1;
        return HttpResponse.json({
          items: [
            {
              ...sampleGlobalRunsLive.items[0],
              // Fresh anchor so the label ticks in seconds ("5s" → "6s").
              started_at: new Date(Date.now() - 5000).toISOString(),
            },
          ],
          total: 1,
        });
      }),
    );
    const { wrapper } = await mountHome();
    const callsAfterMount = calls;

    const before = wrapper.find('[data-test="live-ticker"]').text();
    await flush(1100);
    const after = wrapper.find('[data-test="live-ticker"]').text();
    expect(after).not.toBe(before);
    expect(calls).toBe(callsAfterMount); // ticked forward with zero network
  });

  it('clamps a skewed (future) started_at to zero, never negative', async () => {
    server.use(
      http.get('/api/runs', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status') ?? '';
        if (!status.includes('running')) return HttpResponse.json(sampleGlobalRunsAttention);
        return HttpResponse.json({
          items: [
            {
              ...sampleGlobalRunsLive.items[0],
              started_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
          total: 1,
        });
      }),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="live-ticker"]').text()).toBe('0s');
  });

  it('renders an idle empty state with no live runs', async () => {
    server.use(
      http.get('/api/runs', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status') ?? '';
        if (status.includes('running')) return HttpResponse.json({ items: [], total: 0 });
        return HttpResponse.json(sampleGlobalRunsAttention);
      }),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="live-empty"]').exists()).toBe(true);
  });
});

describe('Home — spend (US6)', () => {
  it('defaults to 24h and switches periods with ZERO extra requests', async () => {
    let summaryCalls = 0;
    server.use(
      http.get('/api/home/summary', () => {
        summaryCalls += 1;
        return HttpResponse.json(sampleHomeSummary);
      }),
    );
    const { wrapper } = await mountHome();
    const callsAfterMount = summaryCalls;

    expect(wrapper.find('[data-test="spend-total"]').text()).toBe('$18.42');
    expect(wrapper.find('[data-test="spend-meta"]').text()).toContain('37 runs');

    const group = wrapper
      .find('[data-test="spend-card"]')
      .findComponent({ name: 'ElRadioGroup' });
    group.vm.$emit('update:modelValue', '30d');
    await flush();

    expect(wrapper.find('[data-test="spend-total"]').text()).toBe('$342.77');
    expect(wrapper.find('[data-test="spend-meta"]').text()).toContain('861 runs');
    expect(summaryCalls).toBe(callsAfterMount); // pure client-side flip
  });

  it('renders $0.00 for a zero-spend period, not an empty state', async () => {
    server.use(
      http.get('/api/home/summary', () =>
        HttpResponse.json({
          ...sampleHomeSummary,
          spend: {
            '24h': { total_cost_usd: '0', run_count: 0 },
            '7d': { total_cost_usd: '0', run_count: 0 },
            '30d': { total_cost_usd: '0', run_count: 0 },
          },
        }),
      ),
    );
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="spend-total"]').text()).toBe('$0.00');
  });
});

describe('Home — workspace cards (US5)', () => {
  it('renders every workspace card with its aggregates and variant states', async () => {
    const { wrapper } = await mountHome();

    const cards = wrapper.findAll('[data-test="ws-card"]');
    expect(cards.length).toBe(3);

    // Active workspace with a 24h failure marker and a running last run.
    expect(cards[0].text()).toContain('Acme');
    expect(cards[0].text()).toContain('BRIG');
    expect(cards[0].find('[data-test="ws-state"]').text()).toBe('active');
    expect(cards[0].text()).toContain('4 agents');
    expect(cards[0].find('[data-test="run-status"]').text()).toContain('running');
    expect(cards[0].find('[data-test="ws-alert"]').text()).toContain('1 failed in last 24h');

    // Paused workspace: muted card + paused tag + calm note.
    expect(cards[1].find('[data-test="ws-state"]').text()).toBe('paused');
    expect(cards[1].classes()).toContain('paused');
    expect(cards[1].find('[data-test="ws-ok"]').text()).toContain('no failures');

    // Runless workspace: explicit "no runs yet".
    expect(cards[2].find('[data-test="ws-no-runs"]').text()).toBe('no runs yet');
  });

  it('a card opens the workspace (runs tab)', async () => {
    const { wrapper, router } = await mountHome();
    await wrapper.findAll('[data-test="ws-card"]')[0].trigger('click');
    await settle(() => router.currentRoute.value.name === 'runs');
    expect(router.currentRoute.value.path).toBe('/workspaces/ws-1/runs');
  });

  it('links to the full workspace list', async () => {
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="grid-all-workspaces"]').attributes('href')).toBe(
      '/workspaces',
    );
  });

  it('renders the create-guidance empty state with zero workspaces', async () => {
    server.use(http.get('/api/home/workspaces', () => HttpResponse.json({ items: [] })));
    const { wrapper } = await mountHome();
    expect(wrapper.find('[data-test="grid-empty"]').exists()).toBe(true);
  });
});

describe('Home — per-block degradation (FR-024)', () => {
  it('a failing summary blanks only the tiles/spend blocks; lists keep rendering', async () => {
    server.use(
      http.get('/api/home/summary', () =>
        HttpResponse.json({ error: { code: 'boom', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { wrapper } = await mountHome();
    await settle(() => wrapper.find('[data-test="tiles-error"]').exists());

    expect(wrapper.find('[data-test="tiles-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="spend-error"]').exists()).toBe(true);
    // Sibling blocks still render their data.
    expect(wrapper.findAll('[data-test="hero-row"]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-test="attention-row"]').length).toBeGreaterThan(0);
    expect(wrapper.findAll('[data-test="ws-card"]').length).toBe(
      sampleHomeWorkspaces.items.length,
    );
  });

  it('a failing global runs endpoint degrades only the two run lists', async () => {
    server.use(
      http.get('/api/runs', () =>
        HttpResponse.json({ error: { code: 'boom', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { wrapper } = await mountHome();
    await settle(() => wrapper.find('[data-test="attention-error"]').exists());

    expect(wrapper.find('[data-test="attention-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="live-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="tile-running"]').text()).toContain('2');
    expect(wrapper.findAll('[data-test="hero-row"]').length).toBeGreaterThan(0);
  });
});
