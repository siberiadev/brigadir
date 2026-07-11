import { describe, it, expect } from 'vitest';
import { AgentsConfigSchema } from './agents-config.schema';

const valid = {
  workspace: {
    jira_site: 'https://acme.atlassian.net',
    project_key: 'BRIG',
    board_id: 42,
    repo: 'git@github.com:acme/product.git',
    default_branch: 'main',
  },
  executors: {
    'mock-exec': { type: 'mock', concurrency: 2 },
  },
  agents: [
    {
      name: 'implementer',
      executor: 'mock-exec',
      instruction: 'Implement the ticket.',
      trigger_status: 'Ready for Dev',
      status_success: 'Code Review',
      status_failure: 'Blocked',
    },
  ],
};

describe('AgentsConfigSchema', () => {
  it('accepts a valid config and applies defaults', () => {
    const res = AgentsConfigSchema.safeParse(valid);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.agents[0].timeout_minutes).toBe(45);
      expect(res.data.agents[0].max_attempts).toBe(2);
    }
  });

  it('rejects a missing required field with the field path', () => {
    const broken = structuredClone(valid);
    // @ts-expect-error intentional deletion for the test
    delete broken.agents[0].status_success;
    const res = AgentsConfigSchema.safeParse(broken);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'agents.0.status_success')).toBe(
        true,
      );
    }
  });

  it('rejects a wrong-type field with the field path', () => {
    const broken = structuredClone(valid);
    // @ts-expect-error intentional wrong type
    broken.executors['mock-exec'].concurrency = 'two';
    const res = AgentsConfigSchema.safeParse(broken);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join('.') === 'executors.mock-exec.concurrency'),
      ).toBe(true);
    }
  });

  it('rejects an agent referencing an unknown executor (dangling ref)', () => {
    const broken = structuredClone(valid);
    broken.agents[0].executor = 'does-not-exist';
    const res = AgentsConfigSchema.safeParse(broken);
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'agents.0.executor');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('does-not-exist');
    }
  });

  it('rejects duplicate agent names', () => {
    const broken = structuredClone(valid);
    broken.agents.push(structuredClone(valid.agents[0]));
    const res = AgentsConfigSchema.safeParse(broken);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'agents.1.name')).toBe(true);
    }
  });

  // --- iteration 2: board binding + scope filter + forward-compat keys ---

  it('accepts the full documented §0.1 workspace shape (board_id, scope_jql, branch_prefix, repositories[])', () => {
    const full = structuredClone(valid);
    full.workspace = {
      jira_site: 'https://acme.atlassian.net',
      project_key: 'BRIG',
      board_id: 42,
      scope_jql: 'labels = ai-pipeline',
      branch_prefix: 'feat',
      repositories: [
        { name: 'product', url: 'git@github.com:acme/product.git', default_branch: 'main' },
        { name: 'frontend', url: 'git@github.com:acme/frontend.git', default_branch: 'main' },
      ],
    } as (typeof valid)['workspace'];
    const res = AgentsConfigSchema.safeParse(full);
    expect(res.success).toBe(true);
  });

  it('rejects a workspace missing board_id with the field path', () => {
    const broken = structuredClone(valid);
    // @ts-expect-error intentional deletion for the test
    delete broken.workspace.board_id;
    const res = AgentsConfigSchema.safeParse(broken);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'workspace.board_id')).toBe(true);
    }
  });

  it('still rejects a genuinely unknown workspace key (strict)', () => {
    const broken = structuredClone(valid);
    // @ts-expect-error intentional unknown key
    broken.workspace.totally_unknown = true;
    const res = AgentsConfigSchema.safeParse(broken);
    expect(res.success).toBe(false);
    if (!res.success) {
      // strict() reports unrecognized keys at the object's path with the key name in `keys`.
      expect(
        res.error.issues.some(
          (i) =>
            i.code === 'unrecognized_keys' &&
            i.path.join('.') === 'workspace' &&
            (i as { keys?: string[] }).keys?.includes('totally_unknown'),
        ),
      ).toBe(true);
    }
  });
});
