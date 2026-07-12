import { describe, it, expect } from 'vitest';
import { WorkspaceSettingsSchema, JiraCredentialsSchema } from './jira.types';

describe('WorkspaceSettingsSchema (T036)', () => {
  it('parses a representative settings blob', () => {
    const res = WorkspaceSettingsSchema.safeParse({
      scope_jql: 'labels = ai-pipeline',
      reconcile: { high_water_mark: '2026-07-11T09:12:33.000Z', active_sprint_id: 4123 },
    });
    expect(res.success).toBe(true);
  });

  it('accepts an empty blob (all defaults)', () => {
    expect(WorkspaceSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a malformed high_water_mark', () => {
    const res = WorkspaceSettingsSchema.safeParse({ reconcile: { high_water_mark: 'not-a-date' } });
    expect(res.success).toBe(false);
  });

  it('parses an ordered repositories list (feature 005, first = default)', () => {
    const res = WorkspaceSettingsSchema.safeParse({
      repositories: [
        { name: 'api', git_url: 'git@github.com:acme/api.git', default_branch: 'main' },
        { name: 'web', git_url: 'git@github.com:acme/web.git', default_branch: 'develop' },
      ],
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.repositories?.[0].name).toBe('api'); // ordered: first = default
    }
  });

  it('still parses iteration-1 seed leftovers (repo/default_branch — forward-compat)', () => {
    const res = WorkspaceSettingsSchema.safeParse({ repo: 'legacy', default_branch: 'main' });
    expect(res.success).toBe(true);
  });

  it('rejects a repository missing git_url', () => {
    const res = WorkspaceSettingsSchema.safeParse({
      repositories: [{ name: 'api', default_branch: 'main' }],
    });
    expect(res.success).toBe(false);
  });
});

describe('JiraCredentialsSchema (T036)', () => {
  it('parses email + api_token and rejects extras', () => {
    expect(JiraCredentialsSchema.safeParse({ email: 'bot@x.io', api_token: 't' }).success).toBe(
      true,
    );
    expect(
      JiraCredentialsSchema.safeParse({ email: 'bot@x.io', api_token: 't', extra: 1 }).success,
    ).toBe(false);
  });
});
