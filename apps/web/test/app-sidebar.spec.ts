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
import '../src/views/settings/PlatformSettings.vue';
import '../src/views/settings/SettingsExecutors.vue';

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

describe('AppSidebar — active highlight (US2)', () => {
  const active = (wrapper: ReturnType<typeof mountSidebar>, dt: string) =>
    wrapper.find(`[data-test="${dt}"]`).classes().includes('is-active');

  it.each(['/', '/workspaces/ws-1/agents', '/workspaces/ws-1/settings'])(
    'marks Workspaces active (not Human queue) at %s (FR-006, deep sub-routes)',
    async (path) => {
      const { wrapper } = await mountAuthedApp(path);
      expect(active(wrapper, 'nav-workspaces')).toBe(true);
      expect(active(wrapper, 'nav-human-queue')).toBe(false);
    },
  );

  it('marks Human queue active (not Workspaces) at /human-queue (FR-006)', async () => {
    const { wrapper } = await mountAuthedApp('/human-queue');
    expect(active(wrapper, 'nav-human-queue')).toBe(true);
    expect(active(wrapper, 'nav-workspaces')).toBe(false);
  });

  it('marks NEITHER active on a run card /runs/:id (FR-007, no matching section)', async () => {
    const { wrapper } = await mountAuthedApp('/runs/r-1');
    expect(active(wrapper, 'nav-workspaces')).toBe(false);
    expect(active(wrapper, 'nav-human-queue')).toBe(false);
  });
});

describe('AppSidebar — platform Settings gear (2026-07-13)', () => {
  const active = (wrapper: ReturnType<typeof mountSidebar>, dt: string) =>
    wrapper.find(`[data-test="${dt}"]`).classes().includes('is-active');

  it('renders the gear above the bottom-pinned Sign out, wrapped in a right-placed "Settings" tooltip', async () => {
    const { wrapper } = await mountAuthedApp('/');

    const gear = wrapper.find('[data-test="nav-settings"]');
    expect(gear.exists()).toBe(true);
    // Both live in the bottom-pinned group, gear BEFORE sign out. The gear's
    // AnimatedIcon wrapper (spin effect, 2026-07-14) is filtered out — it is
    // presentation inside the nav item, not a sibling control.
    const bottom = wrapper.find('.sidebar-bottom');
    const order = bottom
      .findAll('[data-test]')
      .map((n) => n.attributes('data-test'))
      .filter((t) => t !== 'animated-icon');
    expect(order).toEqual(['nav-settings', 'sidebar-sign-out']);
    expect(wrapper.find('[data-test="nav-settings"] .animated-icon--spin').exists()).toBe(true);

    const tip = tooltips(wrapper).find((t) => t.content === 'Settings');
    expect(tip).toBeTruthy();
    expect(tip!.placement).toBe('right');
  });

  it.each(['/settings', '/settings/executors'])(
    'marks the gear active for %s (active for /settings/*), and no other section',
    async (path) => {
      const { wrapper } = await mountAuthedApp(path);
      await settle(() => active(wrapper as never, 'nav-settings'));
      expect(active(wrapper as never, 'nav-settings')).toBe(true);
      expect(active(wrapper as never, 'nav-workspaces')).toBe(false);
      expect(active(wrapper as never, 'nav-human-queue')).toBe(false);
    },
  );

  it('the gear is NOT active elsewhere (workspace settings tab is a different surface)', async () => {
    const { wrapper } = await mountAuthedApp('/workspaces/ws-1/settings');
    expect(active(wrapper as never, 'nav-settings')).toBe(false);
  });
});

describe('AppSidebar — open-count badge (US2)', () => {
  const badge = (wrapper: ReturnType<typeof mountSidebar>) =>
    wrapper.findComponent({ name: 'ElBadge' });

  it('shows the value on the Human queue icon when openCount > 0 (FR-008)', () => {
    const wrapper = mountSidebar(3);
    const b = badge(wrapper);
    expect(b.props('hidden')).toBe(false);
    expect(b.props('value')).toBe(3);
    expect(wrapper.find('[data-test="queue-badge"]').text()).toContain('3');
  });

  it('caps the display at 99+ for a large value (FR-010, > 99)', () => {
    const wrapper = mountSidebar(250);
    expect(badge(wrapper).props('max')).toBe(99);
    expect(wrapper.find('[data-test="queue-badge"]').text()).toContain('99+');
  });

  it('renders NO visible badge at openCount === 0 (FR-009, not-yet-loaded → 0)', () => {
    const wrapper = mountSidebar(0);
    expect(badge(wrapper).props('hidden')).toBe(true);
  });

  it('carries the badge only on Human queue, never on Workspaces', () => {
    const wrapper = mountSidebar(5);
    expect(wrapper.findAllComponents({ name: 'ElBadge' }).length).toBe(1);
    expect(wrapper.find('[data-test="nav-workspaces"]').findComponent({ name: 'ElBadge' }).exists()).toBe(
      false,
    );
  });

  it('updates the badge when the prop changes (FR-010, US2 scenario 5)', async () => {
    const wrapper = mountSidebar(2);
    expect(wrapper.find('[data-test="queue-badge"]').text()).toContain('2');
    await wrapper.setProps({ openCount: 7 });
    expect(wrapper.find('[data-test="queue-badge"]').text()).toContain('7');
    await wrapper.setProps({ openCount: 0 });
    expect(badge(wrapper).props('hidden')).toBe(true);
  });
});

describe('AppSidebar — sign out (US3)', () => {
  it('clears the token and drops back to the sidebar-free gate (FR-012, SC-005)', async () => {
    const { wrapper } = await mountAuthedApp('/');

    // The sign-out control names itself "Sign out".
    expect(tooltips(wrapper).some((t) => t.content === 'Sign out')).toBe(true);
    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(true);

    await wrapper.find('[data-test="sidebar-sign-out"]').trigger('click');
    await settle(() => !wrapper.find('[data-test="app-sidebar"]').exists());

    // Token gone → full-screen gate, no rail.
    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="token-input"]').exists()).toBe(true);
  });
});

describe('AppSidebar — pre-auth gate has no sidebar (US4)', () => {
  it('renders the full-screen gate with NO sidebar until a token is set (FR-013, SC-004)', async () => {
    // No token: the gate is shown and the rail must be absent.
    server.use(http.get('/api/human-tasks/count', () => HttpResponse.json({ open: 0 })));
    const wrapper = mountWithProviders(App, { routes, initialPath: '/' });
    await wrapper.vm.$router.isReady();
    await flush();

    expect(wrapper.find('[data-test="token-input"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(false);

    // Enter a valid token → the shell re-renders and the sidebar appears.
    await wrapper.find('[data-test="token-input"]').setValue('a-token');
    await wrapper.find('[data-test="token-submit"]').trigger('click');
    await settle(() => wrapper.find('[data-test="app-sidebar"]').exists());

    expect(wrapper.find('[data-test="app-sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="token-input"]').exists()).toBe(false);
  });
});
