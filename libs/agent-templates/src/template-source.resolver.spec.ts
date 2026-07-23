import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLE_TEMPLATES, MAX_TEMPLATE_BODY_BYTES } from '@brigadir/contracts';
import type { RoleTemplate } from '@brigadir/contracts';
import { resolveTemplateSource, capTemplates } from './template-source.resolver';

describe('resolveTemplateSource', () => {
  it('resolves to built-in defaults when nothing is configured (US1)', () => {
    const { source, templates } = resolveTemplateSource();
    expect(source.level).toBe('builtin');
    expect(source.fallback_from).toBeUndefined();
    expect(templates.map((t) => t.slug).sort()).toEqual(
      DEFAULT_ROLE_TEMPLATES.map((t) => t.slug).sort(),
    );
  });
});

describe('capTemplates', () => {
  it('returns templates in lexicographic slug order', () => {
    const capped = capTemplates(DEFAULT_ROLE_TEMPLATES);
    expect(capped.map((t) => t.slug)).toEqual(['developer', 'planner', 'qa', 'reviewer']);
  });

  it('truncates an oversized body and flags truncated', () => {
    const big: RoleTemplate = {
      slug: 'big',
      role: 'Big',
      body: 'x'.repeat(MAX_TEMPLATE_BODY_BYTES + 100),
    };
    const [capped] = capTemplates([big]);
    expect(capped.truncated).toBe(true);
    expect(capped.body).toContain('[template truncated at cap]');
    expect(Buffer.byteLength(capped.body, 'utf8')).toBeLessThanOrEqual(
      MAX_TEMPLATE_BODY_BYTES + 40,
    );
  });

  it('leaves a within-cap body untouched', () => {
    const [capped] = capTemplates([{ slug: 'ok', role: 'Ok', body: 'small' }]);
    expect(capped.truncated).toBeUndefined();
    expect(capped.body).toBe('small');
  });
});
