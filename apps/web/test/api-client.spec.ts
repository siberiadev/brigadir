import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { createApiClient, ApiError } from '../src/api/client';

// T147: the client attaches the bearer header, and a 422 error body maps to a
// typed ApiError carrying path-qualified issues[] the forms consume.
describe('apiClient', () => {
  it('attaches the runtime bearer token to requests', async () => {
    let seen: string | null = null;
    server.use(
      http.get('/api/workspaces', ({ request }) => {
        seen = request.headers.get('authorization');
        return HttpResponse.json([]);
      }),
    );

    const client = createApiClient({ getToken: () => 'secret-token' });
    await client.get('/api/workspaces');

    expect(seen).toBe('Bearer secret-token');
  });

  it('maps a 422 body to a typed ApiError with path-qualified issues', async () => {
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

    const client = createApiClient({ getToken: () => 't' });
    await expect(client.post('/api/workspaces/verify', {})).rejects.toBeInstanceOf(ApiError);

    try {
      await client.post('/api/workspaces/verify', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as ApiError;
      expect(e.status).toBe(422);
      expect(e.code).toBe('validation_failed');
      expect(e.issueFor('jira_api_token')?.code).toBe('token_invalid');
    }
  });
});
