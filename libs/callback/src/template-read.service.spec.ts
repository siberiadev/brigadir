import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TemplateRepoService } from '@brigadir/agent-templates';
import type { BrigadirDb } from '@brigadir/database';
import { TemplateReadService } from './template-read.service';

/** Minimal drizzle stub: `select().from().where().limit()` → the given rows. */
function fakeDb(rows: Array<{ workspaceId: string }>): BrigadirDb {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    }),
  } as unknown as BrigadirDb;
}

describe('TemplateReadService', () => {
  const templates = new TemplateRepoService();

  it('list(runId) resolves the workspace and returns the built-in catalog', async () => {
    const svc = new TemplateReadService(fakeDb([{ workspaceId: 'ws-1' }]), templates);
    const { source, items } = await svc.list('run-1');
    expect(source.level).toBe('builtin');
    expect(items.map((i) => i.slug)).toContain('developer');
  });

  it('get(runId, slug) returns the full body', async () => {
    const svc = new TemplateReadService(fakeDb([{ workspaceId: 'ws-1' }]), templates);
    const t = await svc.get('run-1', 'developer');
    expect(t.body).toContain('# Role: Developer');
  });

  it('get(runId, unknownSlug) throws a 404 carrying the available slugs', async () => {
    const svc = new TemplateReadService(fakeDb([{ workspaceId: 'ws-1' }]), templates);
    await expect(svc.get('run-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    try {
      await svc.get('run-1', 'nope');
    } catch (err) {
      const res = (err as NotFoundException).getResponse() as { available?: string[] };
      expect(res.available).toContain('developer');
    }
  });

  it('throws run_not_found when the run does not exist', async () => {
    const svc = new TemplateReadService(fakeDb([]), templates);
    await expect(svc.list('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
