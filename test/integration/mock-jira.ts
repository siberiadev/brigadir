import { setupServer, type SetupServerApi } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { ADFDoc, JiraIssue, JiraIssueLink, StatusCategoryKey } from '@brigadir/contracts';

/**
 * Configurable mock Jira (contracts.md C8 / research D11) over msw node
 * interceptors on global fetch. Reproduces: /search/jql nextPageToken
 * pagination echoing requested fields, Agile board/{id} + active-sprint,
 * /transitions GET+POST with 409-on-cue, 429 + Retry-After on cue, ADF comment
 * capture, and issuelinks. Backed by an in-memory store the test drives.
 *
 * Postgres/Redis stay real (global-setup); only Jira HTTP is mocked.
 */

export interface MockJiraConfig {
  baseUrl?: string;
  boardId?: number;
  boardType?: 'kanban' | 'scrum';
  projectKey?: string;
  /** page size for /search/jql pagination (default 2 so pagination is exercised) */
  pageSize?: number;
}

interface StoredIssue {
  key: string;
  id: string;
  summary: string | null;
  statusName: string;
  updated: string;
  issueType: string;
  sprintId?: number;
  issuelinks: JiraIssueLink[];
}

// Default status → category catalog for the statuses the tests use.
const DEFAULT_CATEGORY: Record<string, StatusCategoryKey> = {
  Backlog: 'new',
  'Ready for Dev': 'new',
  'In Progress': 'indeterminate',
  'Code Review': 'indeterminate',
  Blocked: 'indeterminate',
  Done: 'done',
};

export interface MockJira {
  server: SetupServerApi;
  baseUrl: string;
  boardId: number;
  // drivers
  seedIssue(
    key: string,
    opts: {
      status: string;
      id?: string;
      summary?: string;
      updated?: string;
      issueType?: string;
      sprintId?: number;
    },
  ): void;
  setStatus(key: string, status: string): void;
  setCategory(status: string, category: StatusCategoryKey): void;
  addBlockedByLink(key: string, blockerKey: string): void;
  startSprint(sprintId: number, issueKeys: string[]): void;
  arm409OnNextTransition(key: string): void;
  arm429(retryAfterSeconds: number): void;
  // asserters
  commentsFor(key: string): ADFDoc[];
  transitionsFor(key: string): string[];
  /** Clear all in-memory state (issues, comments, transitions, armed flags, sprint). */
  reset(): void;
}

export function mockJira(config: MockJiraConfig = {}): MockJira {
  const baseUrl = (config.baseUrl ?? 'https://mock.atlassian.net').replace(/\/+$/, '');
  const boardId = config.boardId ?? 42;
  const boardType = config.boardType ?? 'kanban';
  const projectKey = config.projectKey ?? 'BRIG';
  const pageSize = config.pageSize ?? 2;

  const issues = new Map<string, StoredIssue>();
  const category: Record<string, StatusCategoryKey> = { ...DEFAULT_CATEGORY };
  const comments = new Map<string, ADFDoc[]>();
  const appliedTransitions = new Map<string, string[]>();
  const armed409 = new Set<string>();
  let armed429Seconds: number | null = null;
  let activeSprintId: number | null = null;

  const catOf = (status: string): StatusCategoryKey => category[status] ?? 'indeterminate';

  const toJiraIssue = (i: StoredIssue): JiraIssue => ({
    key: i.key,
    id: i.id,
    fields: {
      summary: i.summary,
      status: { name: i.statusName, statusCategory: { key: catOf(i.statusName) } },
      updated: i.updated,
      issuelinks: i.issuelinks,
    },
  });

  /** Consume a one-shot 429 arm; returns a 429 response when armed. */
  const maybe429 = (): HttpResponse | null => {
    if (armed429Seconds == null) return null;
    const retryAfter = armed429Seconds;
    armed429Seconds = null;
    return new HttpResponse(null, {
      status: 429,
      headers: { 'Retry-After': String(retryAfter), 'RateLimit-Reason': 'per-issue-on-write' },
    });
  };

  const server = setupServer(
    // --- POST /rest/api/3/search/jql (nextPageToken pagination) ---
    http.post(`${baseUrl}/rest/api/3/search/jql`, async ({ request }) => {
      const r = maybe429();
      if (r) return r;
      const body = (await request.json()) as { fields?: string[]; nextPageToken?: string };
      const all = [...issues.values()].sort((a, b) => a.key.localeCompare(b.key));
      const start = body.nextPageToken ? Number(body.nextPageToken) : 0;
      const slice = all.slice(start, start + pageSize);
      const nextStart = start + pageSize;
      const requested = body.fields ?? [];
      const projected = slice.map((i) => {
        const full = toJiraIssue(i);
        // echo only requested fields (search always includes key/id)
        const fields: Record<string, unknown> = {};
        for (const f of requested) fields[f] = (full.fields as Record<string, unknown>)[f];
        return { key: full.key, id: full.id, fields };
      });
      return HttpResponse.json({
        issues: projected,
        ...(nextStart < all.length ? { nextPageToken: String(nextStart) } : {}),
      });
    }),

    // --- Agile board introspection (404 for an unknown/inaccessible board) ---
    http.get(`${baseUrl}/rest/agile/1.0/board/:id`, ({ params }) => {
      if (Number(params.id) !== boardId) {
        return HttpResponse.json({ errorMessages: ['board does not exist or no access'] }, { status: 404 });
      }
      return HttpResponse.json({ id: boardId, type: boardType, location: { projectKey } });
    }),
    http.get(`${baseUrl}/rest/agile/1.0/board/:id/sprint`, () =>
      HttpResponse.json({ values: activeSprintId != null ? [{ id: activeSprintId }] : [] }),
    ),

    // --- transitions ---
    http.get(`${baseUrl}/rest/api/3/issue/:key/transitions`, () =>
      HttpResponse.json({
        transitions: Object.keys(category).map((name) => ({ id: `t-${name}`, to: { name } })),
      }),
    ),
    http.post(`${baseUrl}/rest/api/3/issue/:key/transitions`, async ({ request, params }) => {
      const r = maybe429();
      if (r) return r;
      const key = params.key as string;
      if (armed409.has(key)) {
        armed409.delete(key);
        return HttpResponse.json({ errorMessages: ['conflict'] }, { status: 409 });
      }
      const body = (await request.json()) as { transition: { id: string } };
      const target = body.transition.id.replace(/^t-/, '');
      const issue = issues.get(key);
      if (issue) issue.statusName = target;
      appliedTransitions.set(key, [...(appliedTransitions.get(key) ?? []), target]);
      return new HttpResponse(null, { status: 204 });
    }),

    // --- comment capture ---
    http.post(`${baseUrl}/rest/api/3/issue/:key/comment`, async ({ request, params }) => {
      const r = maybe429();
      if (r) return r;
      const key = params.key as string;
      const body = (await request.json()) as { body: ADFDoc };
      comments.set(key, [...(comments.get(key) ?? []), body.body]);
      return HttpResponse.json({ id: '10000' }, { status: 201 });
    }),

    // --- single issue (context for transition discovery) ---
    http.get(`${baseUrl}/rest/api/3/issue/:key`, ({ params }) => {
      const issue = issues.get(params.key as string);
      if (!issue) return HttpResponse.json({ errorMessages: ['not found'] }, { status: 404 });
      return HttpResponse.json({
        key: issue.key,
        id: issue.id,
        fields: {
          status: { name: issue.statusName, statusCategory: { key: catOf(issue.statusName) } },
          issuetype: { name: issue.issueType },
          project: { key: projectKey },
        },
      });
    }),
  );

  let idSeq = 10000;

  return {
    server,
    baseUrl,
    boardId,
    seedIssue(key, opts) {
      issues.set(key, {
        key,
        id: opts.id ?? String(++idSeq),
        summary: opts.summary ?? key,
        statusName: opts.status,
        updated: opts.updated ?? new Date().toISOString(),
        issueType: opts.issueType ?? 'Task',
        sprintId: opts.sprintId,
        issuelinks: [],
      });
    },
    setStatus(key, status) {
      const i = issues.get(key);
      if (i) i.statusName = status;
    },
    setCategory(status, cat) {
      category[status] = cat;
    },
    addBlockedByLink(key, blockerKey) {
      const issue = issues.get(key);
      const blocker = issues.get(blockerKey);
      if (!issue || !blocker) throw new Error(`seed both issues before linking (${key}, ${blockerKey})`);
      issue.issuelinks.push({
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: {
          key: blocker.key,
          fields: { status: { name: blocker.statusName, statusCategory: { key: catOf(blocker.statusName) } } },
        },
      });
    },
    startSprint(sprintId, issueKeys) {
      activeSprintId = sprintId;
      for (const k of issueKeys) {
        const i = issues.get(k);
        if (i) i.sprintId = sprintId;
      }
    },
    arm409OnNextTransition(key) {
      armed409.add(key);
    },
    arm429(retryAfterSeconds) {
      armed429Seconds = retryAfterSeconds;
    },
    commentsFor(key) {
      return comments.get(key) ?? [];
    },
    transitionsFor(key) {
      return appliedTransitions.get(key) ?? [];
    },
    reset() {
      issues.clear();
      comments.clear();
      appliedTransitions.clear();
      armed409.clear();
      armed429Seconds = null;
      activeSprintId = null;
      for (const k of Object.keys(category)) {
        if (!(k in DEFAULT_CATEGORY)) delete category[k];
        else category[k] = DEFAULT_CATEGORY[k];
      }
    },
  };
}
