import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { VueWrapper } from '@vue/test-utils';
import { server } from './server';
import { mountWithProviders, flush } from './mount';
import { sampleVerify } from './handlers';
import WorkspaceWizard from '../src/components/WorkspaceWizard/WorkspaceWizard.vue';

/**
 * T151 — Wizard step-2 Verify (US1). msw fakes `/api/*`; we drive the wizard and
 * assert rendered state (identity, field-pinned errors, the value posted).
 */

// Element Plus el-input forwards attrs (inheritAttrs: false) onto the inner
// <input>, so the data-test hook lands directly on the input element.
async function goToConnectionStep(wrapper: VueWrapper) {
  await wrapper.find('[data-test="name-input"]').setValue('Acme');
  await wrapper.find('[data-test="next-button"]').trigger('click');
  await flush();
}

async function fillConnection(wrapper: VueWrapper, board = '42') {
  await wrapper.find('[data-test="site-url-input"]').setValue('https://acme.atlassian.net');
  await wrapper.find('[data-test="email-input"]').setValue('bot@acme.com');
  await wrapper.find('[data-test="token-input"]').setValue('tok-123');
  await wrapper.find('[data-test="board-input"]').setValue(board);
}

function nextButtonDisabled(wrapper: VueWrapper): boolean {
  return (wrapper.find('[data-test="next-button"]').element as HTMLButtonElement).disabled;
}

describe('WorkspaceWizard step 2 — Verify', () => {
  it('renders resolved identity and enables Next on a valid token+board (US1 #1)', async () => {
    const wrapper = mountWithProviders(WorkspaceWizard);
    await goToConnectionStep(wrapper);
    await fillConnection(wrapper);

    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    const identity = wrapper.find('[data-test="verify-identity"]');
    expect(identity.exists()).toBe(true);
    expect(identity.text()).toContain(sampleVerify.bot_display_name);
    expect(identity.text()).toContain(sampleVerify.project_key);
    expect(identity.text()).toContain('kanban');
    expect(nextButtonDisabled(wrapper)).toBe(false);
  });

  it('pins a token_invalid 422 to the token field and keeps Next disabled (US1 #3)', async () => {
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

    const wrapper = mountWithProviders(WorkspaceWizard);
    await goToConnectionStep(wrapper);
    await fillConnection(wrapper);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    expect(wrapper.find('[data-test="verify-identity"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Token could not be verified.');
    expect(nextButtonDisabled(wrapper)).toBe(true);
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

    const wrapper = mountWithProviders(WorkspaceWizard);
    await goToConnectionStep(wrapper);
    await fillConnection(wrapper);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();

    // The board error shows; it is NOT phrased as a token failure.
    expect(wrapper.text()).toContain('Board is not accessible');
    expect(wrapper.text()).not.toContain('Token could not be verified.');
    expect(nextButtonDisabled(wrapper)).toBe(true);
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

    const wrapper = mountWithProviders(WorkspaceWizard);
    await goToConnectionStep(wrapper);
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

    const wrapper = mountWithProviders(WorkspaceWizard);
    await goToConnectionStep(wrapper);
    await fillConnection(wrapper);
    await wrapper.find('[data-test="verify-button"]').trigger('click');
    await flush();
    // advance to repositories
    await wrapper.find('[data-test="next-button"]').trigger('click');
    await flush();
    // create (repositories left blank → filtered out)
    await wrapper.find('[data-test="create-button"]').trigger('click');
    await flush();

    expect(createBody).toBeDefined();
    const expiry = new Date(createBody!.expires_at);
    const expected = new Date();
    expect(expiry.getUTCFullYear()).toBe(expected.getFullYear() + 1);
  });
});
