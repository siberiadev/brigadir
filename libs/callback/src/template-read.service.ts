import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import {
  TemplateRepoService,
  RoleTemplateNotFoundError,
  type TemplateListResult,
} from '@brigadir/agent-templates';
import type { RoleTemplate } from '@brigadir/contracts';

/**
 * TemplateReadService (feature 030 / contracts/role-templates.md §2) — the
 * backend behind the role-template callback tools. Resolves the run's workspace
 * (like JiraReadService) and delegates to the workspace-scoped
 * TemplateRepoService. Read-only: the surface exposes catalog + bodies only,
 * never a source URL-with-credentials or a token (Principle V).
 */
@Injectable()
export class TemplateReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly templates: TemplateRepoService,
  ) {}

  async list(runId: string): Promise<TemplateListResult> {
    const workspaceId = await this.workspaceIdOf(runId);
    return this.templates.list(workspaceId);
  }

  /** Returns the full template, or throws a 404 carrying the available slugs. */
  async get(runId: string, slug: string): Promise<RoleTemplate> {
    const workspaceId = await this.workspaceIdOf(runId);
    try {
      return await this.templates.get(workspaceId, slug);
    } catch (err) {
      if (err instanceof RoleTemplateNotFoundError) {
        throw new NotFoundException({
          ok: false,
          error: `unknown role template "${err.slug}"`,
          available: err.available,
        });
      }
      throw err;
    }
  }

  private async workspaceIdOf(runId: string): Promise<string> {
    const [row] = await this.db
      .select({ workspaceId: schema.runs.workspaceId })
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!row) throw new NotFoundException({ ok: false, error: 'run_not_found' });
    return row.workspaceId;
  }
}
