import { describe, it, expect, vi } from 'vitest';
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

  it('deep-links back to the owning workspace runs list', async () => {
    const wrapper = mountCard();
    await flush();

    const back = wrapper.find('[data-test="back-link"]');
    expect(back.exists()).toBe(true);
    expect(back.text()).toContain('Runs');
    expect(back.attributes('href')).toBe('/workspaces/ws-1/runs');
  });

  it('renders the timeline, history table, and failure diagnostics', async () => {
    const wrapper = mountCard();
    await flush();

    expect(wrapper.find('[data-test="timeline"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="timeline"]').text()).toContain('started');

    const history = wrapper.find('[data-test="history-table"]');
    expect(history.text()).toContain('Implementer');

    // Header meta: agent name in a green tag, executor type + model in a blue one.
    expect(wrapper.find('[data-test="agent-tag"]').text()).toBe('Implementer');
    expect(wrapper.find('[data-test="executor-tag"]').text()).toBe('claude_cli · claude-sonnet-5');

    expect(wrapper.find('[data-test="run-error"]').text()).toContain('boom: exit code 1');
    expect(wrapper.find('[data-test="external-ref"]').text()).toContain('pull/9');
  });

  it('renders events as human-readable items with the body visible inline', async () => {
    const wrapper = mountCard();
    await flush();

    const timeline = wrapper.find('[data-test="timeline"]');
    // Newest first: the API returns events chronologically, the component
    // reverses — the fixture's last event (jira_action, id 6) leads the list.
    expect(timeline.find('.row').attributes('data-test')).toBe('event-6');
    // The Bash tool_call: tool name as the title, the full command in the
    // grey body block right away — no click, no stringified input.
    expect(timeline.text()).toContain('Bash');
    expect(wrapper.find('[data-test="event-body-5"]').text()).toBe('pnpm test');
    expect(timeline.text()).not.toContain('"command"');
    // progress shows a capitalized stage + percent; jira_action a composed body.
    expect(timeline.text()).toContain('Implement');
    expect(timeline.text()).toContain('40%');
    expect(timeline.text()).toContain('→ Review');
    // The `started` event (empty payload) has no body block.
    expect(wrapper.find('[data-test="event-body-1"]').exists()).toBe(false);
    // The header counter shows the number of presented steps (6 fixture events, no dedup).
    expect(wrapper.find('[data-test="timeline-count"]').text()).toBe('6 steps');
  });

  it('hides the report section entirely while there are no checks; the timeline still shows', async () => {
    server.use(
      http.get('/api/runs/:id', () => HttpResponse.json({ ...sampleRunCard, checks: [] })),
    );
    const wrapper = mountCard();
    await flush();
    expect(wrapper.find('[data-test="checks"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="timeline"]').exists()).toBe(true);
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

describe('RunCard — copy session id', () => {
  it('copies the session id from the log event to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const wrapper = mountCard();
    await flush();

    await wrapper.find('[data-test="copy-session-id"]').trigger('click');
    expect(writeText).toHaveBeenCalledWith('s-1');
  });

  it('hides the button when no log event carries a session id', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          events: sampleRunCard.events.filter((e) => e.type !== 'log'),
        }),
      ),
    );
    const wrapper = mountCard();
    await flush();
    expect(wrapper.find('[data-test="copy-session-id"]').exists()).toBe(false);
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
