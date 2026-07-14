import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AnimatedIcon from '../src/components/AnimatedIcon.vue';

// AnimatedIcon is the whole-icon tier of the icon-animation convention
// (CLAUDE.md "UI-конвенции"): any slotted SVG gets a glyph-agnostic hover
// effect chosen by the `effect` prop. Per-part effects are bespoke CSS at the
// usage site and are NOT this component's job.
describe('AnimatedIcon', () => {
  it('renders the slotted icon inside the wrapper', () => {
    const w = mount(AnimatedIcon, { slots: { default: '<svg data-test="glyph"></svg>' } });
    expect(w.find('[data-test="animated-icon"]').exists()).toBe(true);
    expect(w.find('[data-test="glyph"]').exists()).toBe(true);
  });

  it('defaults to the pop effect', () => {
    const w = mount(AnimatedIcon, { slots: { default: '<svg></svg>' } });
    expect(w.classes()).toContain('animated-icon--pop');
  });

  it.each(['spin', 'dip', 'pop', 'wiggle'] as const)('applies the %s effect class', (effect) => {
    const w = mount(AnimatedIcon, { props: { effect }, slots: { default: '<svg></svg>' } });
    expect(w.classes()).toContain(`animated-icon--${effect}`);
  });
});
