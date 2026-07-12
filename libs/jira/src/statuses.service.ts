import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import type { BoardStatus } from '@brigadir/contracts';
import { JIRA_CLIENT } from './jira-client.interface';
import type { JiraClient } from './jira-client.interface';

/** Thrown when the board's status list can't be fetched (→ 502, not empty/stale). */
export class StatusesUnavailable extends Error {
  constructor(readonly workspaceId: string, cause?: unknown) {
    super(`board statuses unavailable for workspace ${workspaceId}: ${String(cause)}`);
    this.name = 'StatusesUnavailable';
  }
}

interface CacheEntry {
  at: number;
  statuses: BoardStatus[];
}

const TTL_MS = 5 * 60 * 1000;

/**
 * Per-workspace board-status source (feature 005, R3/FR-011). Resolves the
 * workspace's `project_key`, calls `getProjectStatuses` (flat + de-duped), and
 * caches the result in-memory per workspace with a 5-minute TTL. `refresh:true`
 * bypasses and repopulates the cache (the agent form issues this on open). An
 * upstream failure surfaces as `StatusesUnavailable` (→ 502) rather than an
 * empty/stale list.
 */
@Injectable()
export class StatusesService {
  private readonly logger = new Logger(StatusesService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    @Inject(JIRA_CLIENT) private readonly jira: JiraClient,
  ) {}

  async get(workspaceId: string, opts: { refresh?: boolean } = {}): Promise<BoardStatus[]> {
    if (!opts.refresh) {
      const hit = this.cache.get(workspaceId);
      if (hit && Date.now() - hit.at < TTL_MS) {
        return hit.statuses;
      }
    }

    const [ws] = await this.db
      .select({ projectKey: schema.workspaces.jiraProjectKey })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    if (!ws) {
      throw new StatusesUnavailable(workspaceId, 'workspace not found');
    }

    let statuses: BoardStatus[];
    try {
      statuses = await this.jira.getProjectStatuses(ws.projectKey);
    } catch (err) {
      this.logger.warn(`getProjectStatuses failed for ${ws.projectKey}: ${String(err)}`);
      throw new StatusesUnavailable(workspaceId, err);
    }

    this.cache.set(workspaceId, { at: Date.now(), statuses });
    return statuses;
  }
}
