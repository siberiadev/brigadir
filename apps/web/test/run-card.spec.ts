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

  // Feature 025: kimi cost is priced against Anthropic's list — indicative only.
  it('marks the cost as indicative for a kimi run; a claude_cli run has no marker', async () => {
    // Default fixture is claude_cli → no marker.
    const claude = mountCard();
    await flush();
    expect(claude.find('[data-test="cost-indicative"]').exists()).toBe(false);

    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          run: { ...sampleRunCard.run, executor_type: 'kimi' },
        }),
      ),
    );
    const kimi = mountCard();
    await flush();
    expect(kimi.find('[data-test="cost-indicative"]').exists()).toBe(true);

    // A kimi run without a cost yet shows a bare "—", no caveat marker.
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          run: { ...sampleRunCard.run, executor_type: 'kimi', cost_usd: null },
        }),
      ),
    );
    const kimiNoCost = mountCard();
    await flush();
    expect(kimiNoCost.find('[data-test="cost-indicative"]').exists()).toBe(false);
  });

  it('shows input/output tokens from the run usage; hidden entirely when a run has none', async () => {
    // Default fixture: usage { input_tokens: 100, output_tokens: 50 }.
    const withUsage = mountCard();
    await flush();
    expect(withUsage.find('[data-test="meta-tokens"]').text()).toBe('100 in / 50 out');

    // Large counts compact to k/M.
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          run: { ...sampleRunCard.run, usage: { input_tokens: 12345, output_tokens: 1234567 } },
        }),
      ),
    );
    const large = mountCard();
    await flush();
    expect(large.find('[data-test="meta-tokens"]').text()).toBe('12.3k in / 1.2M out');

    // No usage (mock runs, legacy runs) → the meta item is absent, no bare "—".
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          run: { ...sampleRunCard.run, usage: undefined },
        }),
      ),
    );
    const withoutUsage = mountCard();
    await flush();
    expect(withoutUsage.find('[data-test="meta-tokens"]').exists()).toBe(false);
  });

  // Feature 028: same indicative convention for deepseek_api runs.
  it('marks the cost as indicative for a deepseek_api run (feature 028)', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          run: { ...sampleRunCard.run, executor_type: 'deepseek_api' },
        }),
      ),
    );
    const deepseek = mountCard();
    await flush();
    expect(deepseek.find('[data-test="cost-indicative"]').exists()).toBe(true);

    // No cost yet → bare "—", no caveat marker.
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          run: { ...sampleRunCard.run, executor_type: 'deepseek_api', cost_usd: null },
        }),
      ),
    );
    const noCost = mountCard();
    await flush();
    expect(noCost.find('[data-test="cost-indicative"]').exists()).toBe(false);
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

  // Feature 019: per-repo artifact lines.
  it('renders one artifact line per repo (name, branch, PR link, counts)', async () => {
    const wrapper = mountCard();
    await flush();

    const artifacts = wrapper.find('[data-test="artifacts"]');
    expect(artifacts.exists()).toBe(true);
    const first = wrapper.find('[data-test="artifact-0"]');
    expect(first.find('[data-test="artifact-repo-0"]').text()).toBe('api');
    expect(first.text()).toContain('feat/BRIG-1');
    expect(first.find('[data-test="artifact-pr-0"]').attributes('href')).toBe(
      'https://github.com/acme/api/pull/9',
    );
    expect(first.text()).toContain('2 commits, 5 files');
    // Second repo: no PR, no files count — only what was reported renders.
    const second = wrapper.find('[data-test="artifact-1"]');
    expect(second.text()).toContain('web');
    expect(second.find('[data-test="artifact-pr-1"]').exists()).toBe(false);
    expect(second.text()).toContain('1 commit');
  });

  it('legacy flat artifacts render one repo-less line; no artifacts → section hidden (US2)', async () => {
    server.use(
      http.get('/api/runs/:id', () =>
        HttpResponse.json({
          ...sampleRunCard,
          artifacts: [
            { repo: null, branch: 'feat/BRIG-1', pr_url: null, commits_count: null, files_changed: 3 },
          ],
        }),
      ),
    );
    const wrapper = mountCard();
    await flush();
    const row = wrapper.find('[data-test="artifact-0"]');
    expect(row.exists()).toBe(true);
    expect(row.find('[data-test="artifact-repo-0"]').exists()).toBe(false);
    expect(row.text()).toContain('feat/BRIG-1');
    expect(row.text()).toContain('3 files');

    server.use(
      http.get('/api/runs/:id', () => HttpResponse.json({ ...sampleRunCard, artifacts: [] })),
    );
    const empty = mountCard();
    await flush();
    expect(empty.find('[data-test="artifacts"]').exists()).toBe(false);
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
