import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mountWithProviders, flush } from './mount';
import { server } from './server';
import { routes } from '../src/router';
import { setDashboardToken, clearDashboardToken } from '../src/api/token';
import App from '../src/App.vue';
import AppSidebar from '../src/components/AppSidebar.vue';
// Static imports warm the module cache so the router's lazy `() => import(...)`
// route components resolve from cache (deterministic navigation under jsdom) —
// the 007 `workspace-tabs.spec.ts` pattern.
import '../src/views/WorkspaceList.vue';
import '../src/views/WorkspacePage.vue';
import '../src/views/AgentsList.vue';
import '../src/views/Runs.vue';
import '../src/views/WorkspaceSettings.vue';
import '../src/views/HumanQueue.vue';
import '../src/views/RunCard.vue';

/**
 * Feature 009 — Icon Sidebar Navigation. These component tests drive the app's
 * REAL routes (imported from `src/router`) through the memory-history harness.
 * `App.vue` is the shell (token gate vs. authenticated sidebar layout); the
 * presentational `AppSidebar.vue` is also mounted directly for the badge cases.
 *
 * Element Plus interactions are driven via `trigger('click')` / `$emit` — the
 * jsdom-safe convention the 006/007 specs use — and tooltip content is asserted
 * on the `ElTooltip` component's `content`/`placement` props (no real hover).
 */

// A stable authed session for the shell tests; cleared after each.
afterEach(() => clearDashboardToken());

/** Flush until `predicate` holds (route commit / async body mount), bounded. */
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 40 && !predicate(); i++) await flush(5);
  await flush();
}

/**
 * Mount the authenticated shell (`App.vue`) at `initialPath`. Seeds a token so
 * the sidebar branch renders, and pins the count endpoint to `open: 0` so the
 * 006 landing watch never redirects `/` mid-test (badge behavior is covered by
 * the direct `mountSidebar` cases).
 */
async function mountAuthedApp(initialPath: string) {
  setDashboardToken('test-token');
  server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
  const wrapper = mountWithProviders(App, { routes, initialPath });
  const router = wrapper.vm.$router;
  await router.isReady();
  await flush();
  return { wrapper, router };
}

/** Mount the presentational sidebar directly with a given `openCount` prop. */
function mountSidebar(openCount: number, initialPath = '/') {
  return mountWithProviders(AppSidebar, { routes, initialPath, props: { openCount } });
}

/** Collect `{ content, placement }` for every rendered `el-tooltip`. */
function tooltips(wrapper: ReturnType<typeof mountSidebar>) {
  return wrapper
    .findAllComponents({ name: 'ElTooltip' })
    .map((t) => ({ content: t.props('content'), placement: t.props('placement') }));
}

describe('AppSidebar — rendering + tooltips (US1)', () => {
  it('renders the rail with brand, both nav icons, and sign out — no top header (SC-001)', async () => {
    const { wrapper } = await mountAuthedApp('/');

    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="sidebar-brand"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="nav-workspaces"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="nav-human-queue"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="sidebar-sign-out"]').exists()).toBe(true);

    // The old header nav is gone (FR-001/013).
    expect(wrapper.find('.app-nav').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'ElHeader' }).exists()).toBe(false);
  });

  it('wraps each icon in a right-placed tooltip with the exact name (SC-007)', async () => {
    const { wrapper } = await mountAuthedApp('/');

    const tips = tooltips(wrapper);
    expect(tips.every((t) => t.placement === 'right')).toBe(true);
    const contents = tips.map((t) => t.content);
    expect(contents).toContain('Workspaces');
    expect(contents).toContain('Human queue');
    expect(contents).toContain('Sign out');
  });
});
