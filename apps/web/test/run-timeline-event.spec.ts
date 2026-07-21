import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { Megaphone, MessageCircleQuestion, FlagTriangleRight, Unplug, Wrench } from 'lucide-vue-next';
import TimelineEvent from '../src/components/RunTimeline/TimelineEvent.vue';
import MarkdownText from '../src/components/MarkdownText.vue';
import type { TimelineItem } from '../src/components/RunTimeline/presenter';

/**
 * TimelineEvent (feature 026, US1): one timeline entry renders its body as
 * Markdown or a monospace block, and a very long body gets a per-entry
 * expand/collapse control. Mounted standalone — no providers needed.
 */

function item(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: 'e-1',
    time: '10:00:05',
    timeTitle: 'full',
    typeKey: 'tool_call',
    title: 'Bash',
    body: 'pnpm test',
    percent: null,
    orchestrator: false,
    iconKey: 'tool_call',
    tags: [],
    bodyFormat: 'mono',
    kv: null,
    legacyTruncated: false,
    fieldTruncated: false,
    ...overrides,
  };
}

describe('TimelineEvent', () => {
  it('renders a markdown body via MarkdownText', () => {
    const wrapper = mount(TimelineEvent, {
      props: { item: item({ bodyFormat: 'markdown', body: '## Heading\n\n- one' }) },
    });
    expect(wrapper.findComponent(MarkdownText).exists()).toBe(true);
    expect(wrapper.find('pre.mono').exists()).toBe(false);
  });

  it('renders a mono body in a <pre> block', () => {
    const wrapper = mount(TimelineEvent, { props: { item: item({ bodyFormat: 'mono', body: 'ls -la' }) } });
    expect(wrapper.find('pre.mono').text()).toBe('ls -la');
    expect(wrapper.findComponent(MarkdownText).exists()).toBe(false);
  });

  it('shows no expand control for a short body', () => {
    const wrapper = mount(TimelineEvent, { props: { item: item({ body: 'short' }) } });
    expect(wrapper.find('[data-test="event-toggle-e-1"]').exists()).toBe(false);
  });

  it('collapses a long body and toggles it open in place', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const wrapper = mount(TimelineEvent, { props: { item: item({ bodyFormat: 'markdown', body: long }) } });

    const toggle = wrapper.find('[data-test="event-toggle-e-1"]');
    expect(toggle.exists()).toBe(true);
    expect(wrapper.find('.body').classes()).toContain('collapsed');
    expect(toggle.text()).toBe('Show more');

    await toggle.trigger('click');
    expect(wrapper.find('.body').classes()).not.toContain('collapsed');
    expect(wrapper.find('[data-test="event-toggle-e-1"]').text()).toBe('Show less');
  });

  it('shows a truncation note when a field was capped', () => {
    const wrapper = mount(TimelineEvent, { props: { item: item({ fieldTruncated: true }) } });
    expect(wrapper.find('[data-test="event-note-e-1"]').exists()).toBe(true);
  });

  it('icons are static — no hover-animation hooks', () => {
    const wrapper = mount(TimelineEvent, { props: { item: item() } });
    expect(wrapper.find('.anim-trigger').exists()).toBe(false);
  });

  it('maps each orchestrator iconKey to its distinct lucide glyph', () => {
    const wrench = mount(TimelineEvent, { props: { item: item({ iconKey: 'tool_call' }) } });
    expect(wrench.findComponent(Wrench).exists()).toBe(true);

    const mega = mount(TimelineEvent, { props: { item: item({ iconKey: 'report_progress', orchestrator: true }) } });
    expect(mega.findComponent(Megaphone).exists()).toBe(true);

    const q = mount(TimelineEvent, { props: { item: item({ iconKey: 'request_human', orchestrator: true }) } });
    expect(q.findComponent(MessageCircleQuestion).exists()).toBe(true);

    const flag = mount(TimelineEvent, { props: { item: item({ iconKey: 'complete_task', orchestrator: true }) } });
    expect(flag.findComponent(FlagTriangleRight).exists()).toBe(true);
  });

  it('renders tags with tone classes', () => {
    const wrapper = mount(TimelineEvent, {
      props: {
        item: item({
          tags: [
            { label: 'question', tone: 'info' },
            { label: 'blocking', tone: 'warning' },
          ],
        }),
      },
    });
    const tags = wrapper.findAll('.tag');
    expect(tags).toHaveLength(2);
    expect(tags[0].text()).toBe('question');
    expect(tags[1].classes()).toContain('tag--warning');
  });

  it('renders a kv list (muted key / value), not a JSON blob', () => {
    const wrapper = mount(TimelineEvent, {
      props: {
        item: item({
          body: null,
          bodyFormat: 'kv',
          kv: [
            { key: 'alpha', value: 'one' },
            { key: 'beta', value: '2' },
          ],
        }),
      },
    });
    const dl = wrapper.find('dl.kv');
    expect(dl.exists()).toBe(true);
    expect(dl.findAll('dt').map((n) => n.text())).toEqual(['alpha', 'beta']);
    expect(dl.findAll('dd').map((n) => n.text())).toEqual(['one', '2']);
    expect(wrapper.find('pre.mono').exists()).toBe(false);
  });
});

describe('TimelineEvent — channel_failure (feature 027)', () => {
  it('uses the Unplug icon with the danger accent class and renders the kv block', () => {
    const wrapper = mount(TimelineEvent, {
      props: {
        item: item({
          typeKey: 'channel_failure',
          iconKey: 'channel_failure',
          title: 'Сбой callback-канала',
          body: null,
          bodyFormat: 'kv',
          kv: [
            { key: 'тулза', value: 'complete_task' },
            { key: 'попыток', value: '11' },
          ],
          tags: [{ label: 'network', tone: 'warning' }],
        }),
      },
    });
    expect(wrapper.findComponent(Unplug).exists()).toBe(true);
    expect(wrapper.find('li.event').classes()).toContain('event--channel_failure');
    expect(wrapper.find('dl.kv').text()).toContain('complete_task');
    expect(wrapper.find('.tag').text()).toBe('network');
  });
});
