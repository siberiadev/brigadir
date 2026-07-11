import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import type { JiraBoardType } from '@brigadir/contracts';
import { JIRA_CLIENT, type JiraClient } from './jira-client.interface';
import { JiraAuthError, JiraHttpError } from './jira.errors';

/**
 * Board introspection at connect/seed time (FR-028, US6).
 *
 * Reads `jira_board_id`, calls the Agile API to determine the board TYPE and
 * validate access, and persists `jira_board_type`. An inaccessible/unknown
 * board fails with a clear diagnostic rather than defaulting silently. The
 * config seeder writes `jira_board_id`; this fills `jira_board_type` once a
 * Jira client exists.
 */
@Injectable()
export class WorkspaceConnectionService {
  private readonly logger = new Logger(WorkspaceConnectionService.name);

  constructor(
    @Inject(JIRA_CLIENT) private readonly jira: JiraClient,
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
  ) {}

  async introspectAndPersistBoardType(workspaceId: string): Promise<JiraBoardType> {
    const [ws] = await this.db
      .select({
        boardId: schema.workspaces.jiraBoardId,
        projectKey: schema.workspaces.jiraProjectKey,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    if (!ws) throw new Error(`workspace ${workspaceId} not found`);
    if (ws.boardId == null) {
      throw new JiraAuthError(`workspace ${workspaceId} has no jira_board_id — cannot introspect board`);
    }

    let board: { type: JiraBoardType; projectKey: string };
    try {
      board = await this.jira.getBoard(ws.boardId);
    } catch (err) {
      if (err instanceof JiraHttpError && (err.status === 404 || err.status === 403)) {
        throw new JiraAuthError(
          `Jira board ${ws.boardId} is not accessible (HTTP ${err.status}) — check the board id and the bot's permissions`,
        );
      }
      throw err;
    }

    await this.db
      .update(schema.workspaces)
      .set({ jiraBoardType: board.type, updatedAt: sql`now()` })
      .where(eq(schema.workspaces.id, workspaceId));

    this.logger.log(`workspace ${workspaceId}: board ${ws.boardId} is ${board.type}`);
    return board.type;
  }
}
