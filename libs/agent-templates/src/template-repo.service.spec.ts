import { describe, it, expect } from 'vitest';
import { TemplateRepoService, RoleTemplateNotFoundError } from './template-repo.service';

const WS = 'ws-1';

describe('TemplateRepoService', () => {
  const svc = new TemplateRepoService();

  it('list() returns the built-in catalog as bounded summaries (no body)', async () => {
    const { source, items } = await svc.list(WS);
    expect(source.level).toBe('builtin');
    expect(items.map((i) => i.slug)).toContain('developer');
    for (const item of items) {
      expect(item).not.toHaveProperty('body');
      expect(item.role.length).toBeGreaterThan(0);
    }
  });

  it('get() returns a full template body', async () => {
    const t = await svc.get(WS, 'developer');
    expect(t.slug).toBe('developer');
    expect(t.body).toContain('# Role: Developer');
    expect(t.model_hint).toBe('opus');
  });

  it('get() throws RoleTemplateNotFoundError with the available slugs for an unknown slug', async () => {
    await expect(svc.get(WS, 'nope')).rejects.toBeInstanceOf(RoleTemplateNotFoundError);
    try {
      await svc.get(WS, 'nope');
    } catch (err) {
      const e = err as RoleTemplateNotFoundError;
      expect(e.available).toContain('developer');
      expect(e.slug).toBe('nope');
    }
  });
});
