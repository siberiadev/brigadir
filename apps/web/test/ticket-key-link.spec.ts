import { describe, it, expect } from 'vitest';
import { mountWithProviders } from './mount';
import TicketKeyLink from '../src/components/TicketKeyLink.vue';

/**
 * The shared ticket-key link: the key itself navigates to the INTERNAL
 * ticket-history page, the small icon next to it opens Jira in a new tab.
 */
describe('TicketKeyLink', () => {
  it('renders the key as an internal link and the icon as an external Jira link', () => {
    const wrapper = mountWithProviders(TicketKeyLink, {
      props: {
        workspaceId: 'ws-1',
        ticketKey: 'BRIG-7',
        jiraUrl: 'https://acme.atlassian.net/browse/BRIG-7',
      },
    });

    const internal = wrapper.find('[data-test="ticket-link"]');
    expect(internal.text()).toBe('BRIG-7');
    expect(internal.attributes('href')).toBe('/workspaces/ws-1/tickets/BRIG-7');
    expect(internal.attributes('target')).toBeUndefined();

    const icon = wrapper.find('[data-test="ticket-jira-icon"]');
    expect(icon.attributes('href')).toBe('https://acme.atlassian.net/browse/BRIG-7');
    expect(icon.attributes('target')).toBe('_blank');
    expect(icon.attributes('rel')).toBe('noopener');
    expect(icon.attributes('aria-label')).toBe('Open BRIG-7 in Jira');
  });

  it('renders no Jira icon without a jira_url (waiting rows before backfill, etc.)', () => {
    const wrapper = mountWithProviders(TicketKeyLink, {
      props: { workspaceId: 'ws-1', ticketKey: 'BRIG-7' },
    });
    expect(wrapper.find('[data-test="ticket-link"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="ticket-jira-icon"]').exists()).toBe(false);
  });
});
