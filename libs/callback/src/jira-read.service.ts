import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type BrigadirDb, schema } from '@brigadir/database';
import {
  JiraClientFactory,
  JiraHttpError,
  jiraDescriptionToMarkdown,
  jqlEscape,
} from '@brigadir/jira';
import type { GetTicketInput, SearchTicketsInput } from '@brigadir/contracts';

// Size bounds (D8, FR-011) — hard truncation with explicit indication.
const DESCRIPTION_BUDGET = 4000;
const COMMENT_BUDGET = 1500;
const MAX_COMMENTS = 20;
const DEFAULT_SEARCH_RESULTS = 20;
const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'updated'];

export interface ProjectOverview {
  project_key: string;
  board_type: 'kanban' | 'scrum' | null;
  statuses: Array<{ name: string; category: string }>;
  issue_types: string[];
  active_sprint: { id: number } | null;
}

export interface TicketSearchResult {
  items: Array<{
    key: string;
    summary: string;
    status: string;
    issue_type: string;
    assignee: string | null;
    updated: string;
  }>;
  truncated: boolean;
}

export interface TicketDetailResult {
  key: string;
  summary: string | null;
  status: string;
  issue_type: string;
  labels: string[];
  description: string;
  links: Array<{ type: string; direction: string; key: string; status: string }>;
  comments: Array<{ author: string; created: string; body: string }>;
  truncated: boolean;
}

/**
 * JiraReadService (feature 011, D5/D6/D8 / contracts/jira-read-tools.md) — the
 * backend behind the read-only callback tools. All reads go through the run
 * workspace's own rate-limited Jira access; the agent never holds credentials.
 *
 * Scoping is STRUCTURAL: `search` composes the JQL server-side from bounded
 * filters (raw JQL is never accepted — trivially escapable via `OR project=`),
 * and `getTicket` verifies the resolved issue's project key against the run's
 * workspace before returning anything (403 `out_of_scope`, existence never
 * leaked). No write operation exists on this surface (Principle III).
 */
@Injectable()
export class JiraReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: BrigadirDb,
    private readonly jiraFactory: JiraClientFactory,
  ) {}

  async overview(runId: string): Promise<ProjectOverview> {
    const ws = await this.workspaceOf(runId);
    const jira = await this.jiraFactory.forWorkspace(ws.id);

    const statuses = await jira.getProjectStatuses(ws.projectKey);
    // Best-effort extras: types/sprint degrade to empty rather than failing the read.
    const issueTypes = await jira.getProjectIssueTypes(ws.projectKey).catch(() => []);
    // A scrum board may run several active sprints; the overview surfaces the
    // first (agent-facing ProjectOverview.active_sprint stays a single id).
    const sprintIds =
      ws.boardType === 'scrum' && ws.boardId !== null
        ? await jira.getActiveSprintIds(ws.boardId).catch(() => [])
        : [];

    return {
      project_key: ws.projectKey,
      board_type: ws.boardType,
      statuses: statuses.map((s) => ({ name: s.name, category: s.statusCategory })),
      issue_types: issueTypes,
      active_sprint: sprintIds.length > 0 ? { id: sprintIds[0] } : null,
    };
  }

  async search(runId: string, input: SearchTicketsInput): Promise<TicketSearchResult> {
    const ws = await this.workspaceOf(runId);
    const jira = await this.jiraFactory.forWorkspace(ws.id);

    // Server-composed JQL (D6). Values are quoted with escaped quotes; the
    // filters are bounded strings from a .strict() schema.
    const clauses = [`project = "${jqlEscape(ws.projectKey)}"`];
    // Scrum boards scope to the active sprint, mirroring the poller's rules.
    if (ws.boardType === 'scrum') clauses.push('sprint in openSprints()');
    if (input.status) clauses.push(`status = "${jqlEscape(input.status)}"`);
    if (input.issue_type) clauses.push(`issuetype = "${jqlEscape(input.issue_type)}"`);
    if (input.text) clauses.push(`text ~ "${jqlEscape(input.text)}"`);
    const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;

    const max = input.max_results ?? DEFAULT_SEARCH_RESULTS;
    const issues = await jira.searchIssues(jql, SEARCH_FIELDS, max);

    return {
      items: issues.map((i) => ({
        key: i.key,
        summary: i.fields?.summary ?? '',
        status: i.fields?.status?.name ?? '',
        issue_type: (i.fields as { issuetype?: { name?: string } })?.issuetype?.name ?? '',
        assignee:
          (i.fields as { assignee?: { displayName?: string } | null })?.assignee?.displayName ??
          null,
        updated: (i.fields as { updated?: string })?.updated ?? '',
      })),
      truncated: issues.length >= max,
    };
  }

  async getTicket(runId: string, input: GetTicketInput): Promise<TicketDetailResult> {
    const ws = await this.workspaceOf(runId);
    const jira = await this.jiraFactory.forWorkspace(ws.id);

    let detail;
    try {
      detail = await jira.getIssueDetail(input.key);
    } catch (err) {
      if (err instanceof JiraHttpError && err.status === 404) {
        throw new NotFoundException({ ok: false, error: 'ticket_not_found' });
      }
      throw err;
    }

    // Scope check FIRST — an out-of-scope key returns 403 whether or not the
    // issue exists, and none of its content ever leaves this method.
    if (detail.projectKey !== ws.projectKey) {
      throw new ForbiddenException({ ok: false, error: 'out_of_scope' });
    }

    let truncated = false;
    const cut = (value: string, budget: number): string => {
      if (value.length <= budget) return value;
      truncated = true;
      return `${value.slice(0, budget)}…[truncated]`;
    };

    const comments = detail.comments.slice(0, MAX_COMMENTS).map((c) => ({
      author: c.author,
      created: c.created,
      body: cut(jiraDescriptionToMarkdown(c.body), COMMENT_BUDGET),
    }));
    if (detail.comments.length > MAX_COMMENTS) truncated = true;

    return {
      key: detail.key,
      summary: detail.summary,
      status: detail.status,
      issue_type: detail.issueType,
      labels: detail.labels,
      description: cut(jiraDescriptionToMarkdown(detail.description), DESCRIPTION_BUDGET),
      links: detail.links,
      comments,
      truncated,
    };
  }

  private async workspaceOf(runId: string): Promise<{
    id: string;
    projectKey: string;
    boardType: 'kanban' | 'scrum' | null;
    boardId: number | null;
  }> {
    const [row] = await this.db
      .select({
        id: schema.workspaces.id,
        projectKey: schema.workspaces.jiraProjectKey,
        boardType: schema.workspaces.jiraBoardType,
        boardId: schema.workspaces.jiraBoardId,
      })
      .from(schema.runs)
      .innerJoin(schema.workspaces, eq(schema.runs.workspaceId, schema.workspaces.id))
      .where(eq(schema.runs.id, runId))
      .limit(1);
    if (!row) throw new NotFoundException({ ok: false, error: 'run_not_found' });
    return {
      id: row.id,
      projectKey: row.projectKey,
      boardType: (row.boardType as 'kanban' | 'scrum' | null) ?? null,
      boardId: row.boardId,
    };
  }
}
