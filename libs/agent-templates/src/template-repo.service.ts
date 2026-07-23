import { Inject, Injectable } from '@nestjs/common';
import type { ResolvedTemplateSource, RoleTemplate, RoleTemplateSummary } from '@brigadir/contracts';
import { DRIZZLE, type BrigadirDb } from '@brigadir/database';
import { resolveTemplateSource } from './template-source.resolver';

/** Thrown by `get` for a slug not present in the effective source. */
export class RoleTemplateNotFoundError extends Error {
  constructor(
    public readonly slug: string,
    public readonly available: string[],
  ) {
    super(`unknown role template "${slug}"`);
    this.name = 'RoleTemplateNotFoundError';
  }
}

export interface TemplateListResult {
  source: ResolvedTemplateSource;
  items: RoleTemplateSummary[];
}

/** Project a full template to its catalog summary (drops body/truncated). */
export function toSummary(t: RoleTemplate): RoleTemplateSummary {
  return {
    slug: t.slug,
    role: t.role,
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.model_hint !== undefined ? { model_hint: t.model_hint } : {}),
    ...(t.trigger_status_hint !== undefined ? { trigger_status_hint: t.trigger_status_hint } : {}),
  };
}

/**
 * The backend behind the role-template callback tools (feature 030). Resolves a
 * workspace's effective template source and serves the catalog + bodies. US1
 * serves built-in defaults; the `workspaceId` argument is threaded now so US2
 * can resolve per-workspace without a signature change.
 */
@Injectable()
export class TemplateRepoService {
  constructor(@Inject(DRIZZLE) private readonly db: BrigadirDb) {}

  async list(workspaceId: string): Promise<TemplateListResult> {
    const { source, templates } = await resolveTemplateSource(this.db, workspaceId);
    return { source, items: templates.map(toSummary) };
  }

  async get(workspaceId: string, slug: string): Promise<RoleTemplate> {
    const { templates } = await resolveTemplateSource(this.db, workspaceId);
    const found = templates.find((t) => t.slug === slug);
    if (!found) {
      throw new RoleTemplateNotFoundError(
        slug,
        templates.map((t) => t.slug),
      );
    }
    return found;
  }
}
