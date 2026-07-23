import { describe, it, expect, afterEach } from 'vitest';
import { mountWithProviders, flush } from './mount';
import { degradedChannelHealth, sampleChannelHealth } from './handlers';
import ChannelHealthIndicator from '../src/components/ChannelHealthIndicator.vue';

/**
 * Feature 027 (US4): компактный индикатор здоровья callback-канала.
 * Компонент презентационный (данные пропом); здесь — оба состояния, поповер с
 * фактами и click-through к затронутым прогонам.
 */
describe('ChannelHealthIndicator', () => {
  afterEach(() => {
    // Поповер телепортируется в body и переживает unmount wrapper'а между
    // тестами — чистим, чтобы querySelector не находил прошлый поповер.
    document.body.innerHTML = '';
  });

  it('healthy: no danger dot; popover shows counts and guard ok', async () => {
    const wrapper = mountWithProviders(ChannelHealthIndicator, {
      props: { health: sampleChannelHealth },
    });
    expect(wrapper.find('[data-test="channel-health-dot"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="channel-health-indicator"]').classes()).not.toContain(
      'is-degraded',
    );

    await wrapper.find('[data-test="channel-health-indicator"]').trigger('click');
    await flush();
    expect(document.body.querySelector('[data-test="channel-health-status"]')?.textContent).toContain(
      'healthy',
    );
    expect(document.body.querySelector('[data-test="channel-health-guard"]')?.textContent).toContain(
      'ok',
    );
  });

  it('degraded: danger state + dot; popover lists affected runs linking to run cards', async () => {
    const wrapper = mountWithProviders(ChannelHealthIndicator, {
      props: { health: degradedChannelHealth },
    });
    expect(wrapper.find('[data-test="channel-health-dot"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="channel-health-indicator"]').classes()).toContain(
      'is-degraded',
    );

    await wrapper.find('[data-test="channel-health-indicator"]').trigger('click');
    await flush();
    const status = document.body.querySelector('[data-test="channel-health-status"]');
    expect(status?.textContent).toContain('degraded');
    expect(
      document.body.querySelector('[data-test="channel-health-failures"]')?.textContent,
    ).toContain('4');
    const link = document.body.querySelector('[data-test="channel-health-run-run-degraded-1"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/runs/run-degraded-1');
    expect(link?.textContent).toContain('BRIG-42');
  });

  it('null health renders a no-data popover without crashing', async () => {
    const wrapper = mountWithProviders(ChannelHealthIndicator, { props: { health: null } });
    await wrapper.find('[data-test="channel-health-indicator"]').trigger('click');
    await flush();
    expect(document.body.querySelector('[data-test="channel-health-popover"]')?.textContent).toContain(
      'No data',
    );
  });
});
