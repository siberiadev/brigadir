import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleVerify } from './handlers';
import WorkspaceForm from '../src/components/WorkspaceForm/WorkspaceForm.vue';

/**
 * T151 (re-homed) — flat WorkspaceForm Verify (US1). The former wizard collapsed
 * to one screen: Verify is inline, Create lives in the hosting FormDialog footer
 * and is driven by the exposed submit()/canSubmit. msw fakes `/api/*`; we drive
 * the form and assert rendered state (identity, field-pinned errors, the value
 * posted) plus the canSubmit gate that replaces the old step gating.
 */

type Exposed = { submit: () => Promise<void>; canSubmit: boolean };
const exposed = (wrapper: VueWrapper) => wrapper.vm as unknown as Exposed;

// Element Plus el-input forwards attrs (inheritAttrs: false) onto the inner
// <input>, so the data-test hook lands directly on the input element.
async function fillConnection(wrapper: VueWrapper, board = '42') {
  await wrapper.find('[data-test="name-input"]').setValue('Acme');
  await wrapper.find('[data-test="site-url-input"]').setValue('https://acme.atlassian.net');
  await wrapper.find('[data-test="email-input"]').setValue('bot@acme.com');
  await wrapper.find('[data-test="token-input"]').setValue('tok-123');
  await wrapper.find('[data-test="board-input"]').setValue(board);
}

describe('WorkspaceForm — Verify', () => {
  it('renders resolved identity and enables Create (canSubmit) on a valid token+board (US1 #1)', async () => {
    const wrapper = mountWithProviders(WorkspaceForm);
    await fillConnection(wrapper);

    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    const identity = wrapper.find('[data-test="verify-identity"]');
    expect(identity.exists()).toBe(true);
    expect(identity.text()).toContain(sampleVerify.bot_display_name);
    expect(identity.text()).toContain(sampleVerify.project_key);
    expect(identity.text()).toContain('kanban');
    expect(exposed(wrapper).canSubmit).toBe(true);
  });

  it('pins a token_invalid 422 to the token field and keeps Create disabled (US1 #3)', async () => {
    server.use(
      http.post('/api/workspaces/verify', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_failed',
              message: 'Token could not be verified.',
              issues: [
                {
                  path: ['jira_api_token'],
                  code: 'token_invalid',
                  message: 'Token could not be verified.',
                  level: 'error',
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );

    const wrapper = mountWithProviders(WorkspaceForm);
    await fillConnection(wrapper);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="verify-identity"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Token could not be verified.');
    expect(exposed(wrapper).canSubmit).toBe(false);
  });

  it('surfaces a board-distinct message for a board_forbidden 422 (US1 #4)', async () => {
    server.use(
      http.post('/api/workspaces/verify', () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_failed',
              message: 'Board is not accessible with these credentials.',
              issues: [
                {
                  path: ['board'],
                  code: 'board_forbidden',
                  message: 'Board is not accessible with these credentials.',
                  level: 'error',
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    );

    const wrapper = mountWithProviders(WorkspaceForm);
    await fillConnection(wrapper);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    // The board error shows; it is NOT phrased as a token failure.
    expect(wrapper.text()).toContain('Board is not accessible');
    expect(wrapper.text()).not.toContain('Token could not be verified.');
    expect(exposed(wrapper).canSubmit).toBe(false);
  });

  it('sends the pasted board value verbatim to /verify (server extracts the id, US1 #2)', async () => {
    let sentBoard: string | undefined;
    const pastedUrl = 'https://acme.atlassian.net/jira/software/c/projects/BRIG/boards/42';
    server.use(
      http.post('/api/workspaces/verify', async ({ request }) => {
        const body = (await request.json()) as { board: string };
        sentBoard = body.board;
        return HttpResponse.json(sampleVerify);
      }),
    );

    const wrapper = mountWithProviders(WorkspaceForm);
    await fillConnection(wrapper, pastedUrl);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    expect(sentBoard).toBe(pastedUrl);
  });

  it('carries the +1y expires_at default in the create body when unchanged (US1 / FR-004)', async () => {
    let createBody: { expires_at: string } | undefined;
    server.use(
      http.post('/api/workspaces/verify', () => HttpResponse.json(sampleVerify)),
      http.post('/api/workspaces', async ({ request }) => {
        createBody = (await request.json()) as { expires_at: string };
        return HttpResponse.json({ id: 'ws-new' }, { status: 201 });
      }),
    );

    const wrapper = mountWithProviders(WorkspaceForm);
    await fillConnection(wrapper);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();
    // Create is driven by the footer via the exposed submit() (repositories left
    // blank → filtered out).
    await exposed(wrapper).submit();
    await flush();

    expect(createBody).toBeDefined();
    const expiry = new Date(createBody!.expires_at);
    const expected = new Date();
    expect(expiry.getUTCFullYear()).toBe(expected.getFullYear() + 1);
  });
});
