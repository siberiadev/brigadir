import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleRunCard } from './handlers';
import RunCard from '../src/views/RunCard.vue';

/**
 * T043 — Run/ticket card (US2). The four glyph states render, a reason expands
 * on click, timeline + history render, a failed run shows its diagnostics, and
 * cancel/retry hit the faked endpoints.
 */

function mountCard() {
  return mountWithProviders(RunCard, { props: { id: 'run-1' } });
}

describe('RunCard — report + diagnostics', () => {
  it('renders the four check glyphs and expands a reason on click', async () => {
    const wrapper = mountCard();
    await flush();

    expect(wrapper.find('[data-test="glyph-0"]').text()).toBe('✅');
    expect(wrapper.find('[data-test="glyph-1"]').text()).toBe('❌');
    expect(wrapper.find('[data-test="glyph-2"]').text()).toBe('⚠️');
    expect(wrapper.find('[data-test="glyph-3"]').text()).toBe('⏭️');

    // The failed check's reason is collapsed until clicked.
    expect(wrapper.find('[data-test="reason-1"]').exists()).toBe(false);
    await wrapper.find('[data-test="check-toggle-1"]').trigger('click');
    expect(wrapper.find('[data-test="reason-1"]').text()).toContain('3 tests failed');
  });

  it('renders the timeline, history table, and failure diagnostics', async () => {
    const wrapper = mountCard();
    await flush();

    expect(wrapper.find('[data-test="timeline"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="timeline"]').text()).toContain('started');

    const history = wrapper.find('[data-test="history-table"]');
    expect(history.text()).toContain('Implementer');

    expect(wrapper.find('[data-test="run-error"]').text()).toContain('boom: exit code 1');
    expect(wrapper.find('[data-test="external-ref"]').text()).toContain('pull/9');
  });

  it('renders a partial report (no checks) without crashing', async () => {
    server.use(
      http.get('/api/runs/:id', () => HttpResponse.json({ ...sampleRunCard, checks: [] })),
    );
    const wrapper = mountCard();
    await flush();
    expect(wrapper.find('[data-test="checks-empty"]').exists()).toBe(true);
  });

  it('shows a not-found empty state on a 404', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json(
          { error: { code: 'run_not_found', message: 'Run not found.' } },
          { status: 404 },
        ),
      ),
    );
    const wrapper = mountCard();
    await flush();
    expect(wrapper.find('[data-test="run-not-found"]').exists()).toBe(true);
  });
});

describe('RunCard — cancel/retry', () => {
  it('a terminal (failed) run shows Retry and calls the retry endpoint', async () => {
    let retried = false;
    server.use(
      http.post('/api/runs/:id/retry', () => {
        retried = true;
        return HttpResponse.json({ ok: true, run_id: 'run-2', deduplicated: false });
      }),
    );
    const wrapper = mountCard();
    await flush();

    expect(wrapper.find('[data-test="cancel-run"]').exists()).toBe(false);
    await wrapper.find('[data-test="retry-run"]').trigger('click');
    await flush();
    expect(retried).toBe(true);
  });

  it('a running run shows Cancel and calls the cancel endpoint', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({ ...sampleRunCard, run: { ...sampleRunCard.run, status: 'running' } }),
      ),
    );
    let cancelled = false;
    server.use(
      http.post('/api/runs/:id/cancel', () => {
        cancelled = true;
        return HttpResponse.json({ ok: true, cancelled: true });
      }),
    );
    const wrapper = mountCard();
    await flush();

    expect(wrapper.find('[data-test="retry-run"]').exists()).toBe(false);
    await wrapper.find('[data-test="cancel-run"]').trigger('click');
    await flush();
    expect(cancelled).toBe(true);
  });
});
