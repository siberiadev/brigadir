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

  // --- iteration 3: claude_cli executor branch (T075) ---

  const withClaudeCli = () => {
    const config = structuredClone(valid) as {
      workspace: { repositories?: { name: string; url: string; default_branch?: string }[] };
      executors: Record<string, unknown>;
      agents: { executor: string; behavior?: Record<string, unknown> }[];
    };
    config.workspace.repositories = [
      { name: 'product', url: 'git@github.com:acme/product.git', default_branch: 'main' },
    ];
    config.executors['coder'] = {
      type: 'claude_cli',
      model: 'claude-sonnet-5',
      repository: 'product',
      concurrency: 1,
    };
    config.agents[0].executor = 'coder';
    config.agents[0].behavior = { allowed_tools: ['Read', 'Edit', 'Bash(git *)'] };
    return config;
  };

  it('accepts a valid claude_cli executor alongside mock in one config', () => {
    const config = withClaudeCli();
    config.executors['mock-exec'] = { type: 'mock', concurrency: 2 };
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(true);
    if (res.success) {
      const coder = res.data.executors['coder'];
      expect(coder.type).toBe('claude_cli');
      if (coder.type === 'claude_cli') {
        expect(coder.cliPath).toBe('claude');
        expect(coder.keepFailedWorktrees).toBe(false);
        expect(coder.killGraceMs).toBe(5000);
        expect(coder.cancelPollMs).toBe(3000);
      }
    }
  });

  it('rejects a claude_cli `repository` not in workspace.repositories[].name', () => {
    const config = withClaudeCli();
    (config.executors['coder'] as { repository: string }).repository = 'does-not-exist';
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'executors.coder.repository');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('does-not-exist');
    }
  });

  it('rejects a claude_cli executor missing `model`', () => {
    const config = withClaudeCli();
    delete (config.executors['coder'] as { model?: string }).model;
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join('.') === 'executors.coder.model')).toBe(true);
    }
  });

  it('rejects a claude_cli agent with allowedTools omitted and empty behavior.allowed_tools', () => {
    const config = withClaudeCli();
    config.agents[0].behavior = {};
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join('.') === 'agents.0.behavior.allowed_tools'),
      ).toBe(true);
    }
  });

  it('accepts a claude_cli agent when the executor itself declares allowedTools', () => {
    const config = withClaudeCli();
    (config.executors['coder'] as { allowedTools?: string[] }).allowedTools = ['Read', 'Edit'];
    config.agents[0].behavior = {};
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(true);
  });

  // --- feature 019: agent repository scope (behavior.repositories) ---

  const withTwoRepos = () => {
    const config = withClaudeCli();
    config.workspace.repositories!.push({
      name: 'infra',
      url: 'git@github.com:acme/infra.git',
      default_branch: 'main',
    });
    return config;
  };

  it('feature 019: the executor-level `repository` is now optional (runtime-ignored legacy key)', () => {
    const config = withClaudeCli();
    delete (config.executors['coder'] as { repository?: string }).repository;
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(true);
  });

  it('accepts behavior.repositories naming declared workspace repositories', () => {
    const config = withTwoRepos();
    config.agents[0].behavior!.repositories = ['infra', 'product'];
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(true);
  });

  it('accepts the deprecated behavior.repository alongside repositories (list wins, no error)', () => {
    const config = withTwoRepos();
    config.agents[0].behavior!.repositories = ['infra'];
    config.agents[0].behavior!.repository = 'product';
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(true);
  });

  it('rejects an unknown name in behavior.repositories with the per-entry path', () => {
    const config = withTwoRepos();
    config.agents[0].behavior!.repositories = ['infra', 'ghost'];
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find(
        (i) => i.path.join('.') === 'agents.0.behavior.repositories.1',
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('ghost');
    }
  });

  it('rejects an unknown deprecated behavior.repository with the field path', () => {
    const config = withTwoRepos();
    config.agents[0].behavior!.repository = 'ghost';
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some((i) => i.path.join('.') === 'agents.0.behavior.repository'),
      ).toBe(true);
    }
  });

  it('skips the scope check when the workspace declares no repositories (repo-less workspaces stay valid)', () => {
    const config = withClaudeCli();
    delete (config.workspace as { repositories?: unknown }).repositories;
    delete (config.executors['coder'] as { repository?: string }).repository;
    config.agents[0].behavior!.repositories = ['anything'];
    const res = AgentsConfigSchema.safeParse(config);
    expect(res.success).toBe(true);
  });
});
