import { describe, it, expect } from 'vitest';
import { DEFAULT_ROLE_TEMPLATES, MAX_TEMPLATE_BODY_BYTES } from '@brigadir/contracts';
import type { RoleTemplate } from '@brigadir/contracts';
import type { BrigadirDb } from '@brigadir/database';
import { resolveTemplateSource, capTemplates } from './template-source.resolver';

/**
 * Column-shape fake db: the workspace-source query selects {settings, token};
 * the global query selects {key, value}. Precedence + git fallback (real
 * clones) are covered in the integration suite (test/integration).
 */
function fakeDb(opts: { wsSettings?: unknown; global?: Array<{ key: string; value: unknown }> } = {}): BrigadirDb {
  const select = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols ?? {});
    let rows: unknown[] = [];
    if (keys.includes('settings') && keys.includes('token')) {
      rows = [{ settings: opts.wsSettings ?? {}, token: null }];
    } else if (keys.includes('key') && keys.includes('value')) {
      rows = opts.global ?? [];
    }
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: async () => rows,
      then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return builder;
  };
  return { select } as unknown as BrigadirDb;
}

describe('resolveTemplateSource', () => {
  it('resolves to built-in defaults when neither workspace nor global source is configured', async () => {
    const { source, templates } = await resolveTemplateSource(fakeDb(), 'ws-1');
    expect(source.level).toBe('builtin');
    expect(source.fallback_from).toBeUndefined();
    expect(templates.map((t) => t.slug).sort()).toEqual(
      DEFAULT_ROLE_TEMPLATES.map((t) => t.slug).sort(),
    );
  });
});

describe('capTemplates', () => {
  it('returns templates in lexicographic slug order', () => {
    expect(capTemplates(DEFAULT_ROLE_TEMPLATES).map((t) => t.slug)).toEqual([
      'developer',
      'planner',
      'qa',
      'reviewer',
    ]);
  });

  it('truncates an oversized body and flags truncated', () => {
    const big: RoleTemplate = { slug: 'big', role: 'Big', body: 'x'.repeat(MAX_TEMPLATE_BODY_BYTES + 100) };
    const [capped] = capTemplates([big]);
    expect(capped.truncated).toBe(true);
    expect(capped.body).toContain('[template truncated at cap]');
  });

  it('leaves a within-cap body untouched', () => {
    const [capped] = capTemplates([{ slug: 'ok', role: 'Ok', body: 'small' }]);
    expect(capped.truncated).toBeUndefined();
    expect(capped.body).toBe('small');
  });
});
