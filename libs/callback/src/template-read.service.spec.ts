import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TemplateRepoService } from '@brigadir/agent-templates';
import type { BrigadirDb } from '@brigadir/database';
import { TemplateReadService } from './template-read.service';

/**
 * One column-shape fake db serving three query shapes: the runs lookup
 * (`{workspaceId}`), the workspace source (`{settings, token}` → built-in), and
 * the global source (`{key, value}` → none).
 */
function fakeDb(runRows: Array<{ workspaceId: string }>): BrigadirDb {
  const select = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols ?? {});
    let rows: unknown[] = [];
    if (keys.includes('workspaceId')) rows = runRows;
    else if (keys.includes('settings') && keys.includes('token')) rows = [{ settings: {}, token: null }];
    // {key, value} (global source) → [] (none)
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: async () => rows,
      then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) => Promise.resolve(rows).then(r, j),
    };
    return builder;
  };
  return { select } as unknown as BrigadirDb;
}

describe('TemplateReadService', () => {
  const templatesFor = (db: BrigadirDb) => new TemplateReadService(db, new TemplateRepoService(db));

  it('list(runId) resolves the workspace and returns the built-in catalog', async () => {
    const { source, items } = await templatesFor(fakeDb([{ workspaceId: 'ws-1' }])).list('run-1');
    expect(source.level).toBe('builtin');
    expect(items.map((i) => i.slug)).toContain('developer');
  });

  it('get(runId, slug) returns the full body', async () => {
    const t = await templatesFor(fakeDb([{ workspaceId: 'ws-1' }])).get('run-1', 'developer');
    expect(t.body).toContain('# Role: Developer');
  });

  it('get(runId, unknownSlug) throws a 404 carrying the available slugs', async () => {
    const svc = templatesFor(fakeDb([{ workspaceId: 'ws-1' }]));
    await expect(svc.get('run-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    try {
      await svc.get('run-1', 'nope');
    } catch (err) {
      const res = (err as NotFoundException).getResponse() as { available?: string[] };
      expect(res.available).toContain('developer');
    }
  });

  it('throws run_not_found when the run does not exist', async () => {
    await expect(templatesFor(fakeDb([])).list('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
