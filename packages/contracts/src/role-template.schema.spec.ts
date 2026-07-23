import { describe, it, expect } from 'vitest';
import {
  AgentInstructionsSourceSchema,
  RoleTemplateSchema,
  ResolvedTemplateSourceSchema,
  isAllowedGitUrl,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_BODY_BYTES,
  GIT_OP_TIMEOUT_MS,
} from './role-template.schema';

describe('isAllowedGitUrl', () => {
  it('accepts https, ssh, and scp-like remotes', () => {
    expect(isAllowedGitUrl('https://github.com/acme/agents.git')).toBe(true);
    expect(isAllowedGitUrl('ssh://git@github.com/acme/agents.git')).toBe(true);
    expect(isAllowedGitUrl('git@github.com:siberiadev/agents.git')).toBe(true);
  });

  it('rejects file:// and local paths', () => {
    expect(isAllowedGitUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedGitUrl('/Users/dev/agents')).toBe(false);
    expect(isAllowedGitUrl('./agents')).toBe(false);
    expect(isAllowedGitUrl('../agents')).toBe(false);
    expect(isAllowedGitUrl('http://insecure.example/repo.git')).toBe(false);
  });
});

describe('AgentInstructionsSourceSchema', () => {
  it('accepts a well-formed source with optional fields', () => {
    const parsed = AgentInstructionsSourceSchema.parse({
      git_url: 'git@github.com:siberiadev/agents.git',
      git_ref: 'main',
      subdir: 'roles',
    });
    expect(parsed.git_url).toContain('siberiadev/agents');
  });

  it('rejects a file:// url with a path-qualified issue', () => {
    const res = AgentInstructionsSourceSchema.safeParse({ git_url: 'file:///etc' });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].path).toEqual(['git_url']);
  });

  it('rejects a subdir with a .. segment', () => {
    const res = AgentInstructionsSourceSchema.safeParse({
      git_url: 'https://github.com/acme/agents.git',
      subdir: '../secrets',
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].path).toEqual(['subdir']);
  });

  it('rejects an absolute subdir', () => {
    const res = AgentInstructionsSourceSchema.safeParse({
      git_url: 'https://github.com/acme/agents.git',
      subdir: '/roles',
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const res = AgentInstructionsSourceSchema.safeParse({
      git_url: 'https://github.com/acme/agents.git',
      token: 'ghp_x',
    });
    expect(res.success).toBe(false);
  });
});

describe('RoleTemplateSchema', () => {
  it('accepts a full template and allows optional truncated', () => {
    const t = RoleTemplateSchema.parse({
      slug: 'developer',
      role: 'Developer',
      description: 'x',
      model_hint: 'opus',
      trigger_status_hint: 'In Progress',
      body: '# Role',
      truncated: true,
    });
    expect(t.truncated).toBe(true);
  });

  it('requires slug/role/body', () => {
    expect(RoleTemplateSchema.safeParse({ slug: 'x', role: 'X' }).success).toBe(false);
  });
});

describe('ResolvedTemplateSourceSchema', () => {
  it('accepts a builtin resolution and a fallback resolution', () => {
    expect(ResolvedTemplateSourceSchema.parse({ level: 'builtin' }).level).toBe('builtin');
    const fb = ResolvedTemplateSourceSchema.parse({
      level: 'builtin',
      fallback_from: 'global',
      diagnostic: 'clone failed',
    });
    expect(fb.fallback_from).toBe('global');
  });
});

describe('caps', () => {
  it('exposes the documented cap constants', () => {
    expect(MAX_TEMPLATE_FILES).toBe(50);
    expect(MAX_TEMPLATE_BODY_BYTES).toBe(32_768);
    expect(GIT_OP_TIMEOUT_MS).toBe(30_000);
  });
});
