import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLE_TEMPLATES } from './default-role-templates';
import { RoleTemplateSchema, MAX_TEMPLATE_BODY_BYTES } from './role-template.schema';

describe('DEFAULT_ROLE_TEMPLATES', () => {
  it('ships the four reference roles', () => {
    expect(DEFAULT_ROLE_TEMPLATES.map((t) => t.slug)).toEqual([
      'developer',
      'qa',
      'reviewer',
      'planner',
    ]);
  });

  it('every template validates against RoleTemplateSchema', () => {
    for (const t of DEFAULT_ROLE_TEMPLATES) {
      expect(() => RoleTemplateSchema.parse(t)).not.toThrow();
    }
  });

  it('every body is non-empty and within the cap', () => {
    for (const t of DEFAULT_ROLE_TEMPLATES) {
      expect(t.body.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(t.body, 'utf8')).toBeLessThanOrEqual(MAX_TEMPLATE_BODY_BYTES);
    }
  });

  it('carries the model hints that mirror the reference repo', () => {
    const bySlug = Object.fromEntries(DEFAULT_ROLE_TEMPLATES.map((t) => [t.slug, t.model_hint]));
    expect(bySlug).toEqual({
      developer: 'opus',
      qa: 'deepseek',
      reviewer: 'deepseek',
      planner: 'sonnet',
    });
  });

  it('embeds the platform invariant (no direct Jira writes) in every body', () => {
    for (const t of DEFAULT_ROLE_TEMPLATES) {
      expect(t.body).toContain('complete_task');
      expect(t.body.toLowerCase()).toContain('jira');
    }
  });
});
