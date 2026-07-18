import { setupServer, type SetupServerApi } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { ADFDoc, JiraIssue, JiraIssueLink, StatusCategoryKey } from '@brigadir/contracts';

/**
 * Configurable mock Jira (contracts.md C8 / research D11) over msw node
 * interceptors on global fetch. Reproduces: /search/jql nextPageToken
 * pagination echoing requested fields (and applying a small, structured subset
 * of the JQL scope — updated/sprint/labels/key), Agile board/{id} +
 * active-sprint, /transitions GET+POST with 409-on-cue, 429 + Retry-After on
 * cue, ADF comment capture, and issuelinks (resolved LIVE from the blocker's
 * current status so moving a blocker changes the gate). Backed by an in-memory
 * store the test drives. Postgres/Redis stay real (global-setup).
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
  /** ADF body returned by GET /issue/{key} (run-dispatch description fetch). */
  description?: ADFDoc;
  statusName: string;
  updated: string;
  issueType: string;
  sprintId?: number;
  labels: string[];
  /** feature 020: component names served on GET /issue/{key} (repo-scoping input). */
  components: string[];
  /** keys of blockers ("is blocked by"); resolved to live status on read. */
  blockedBy: string[];
  /** feature 004 (T114): epic (parent) key, resolved to live status on read. */
  epicKey?: string;
  /** feature 004 (T114): generic linked issue keys, resolved to live status+summary on read. */
  linked: string[];
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
      description?: ADFDoc;
      updated?: string;
      issueType?: string;
      sprintId?: number;
      labels?: string[];
      components?: string[];
    },
  ): void;
  setStatus(key: string, status: string): void;
  /** feature 020: replace the component names a ticket serves (repo-scoping round trips). */
  setComponents(key: string, components: string[]): void;
  setCategory(status: string, category: StatusCategoryKey): void;
  /** feature 005: require a specific email:apiToken on /myself (else 401 — token_invalid). */
  expectAuth(email: string, apiToken: string): void;
  /** feature 005: display name returned by GET /rest/api/3/myself. */
  setBotDisplayName(name: string): void;
  /** feature 005: arm a one-shot 500 on the next project-statuses fetch (→ 502 upstream). */
  arm500OnStatuses(): void;
  /** Arm a one-shot 500 on the next GET /issue/{key} (run-dispatch description fetch fallback). */
  arm500OnNextIssueGet(): void;
  addBlockedByLink(key: string, blockerKey: string): void;
  /** feature 004 (T114): set this issue's epic (parent) key. */
  setEpic(key: string, epicKey: string): void;
  /** feature 004 (T114): add a generic issue link (both issues must already be seeded). */
  addLinkedIssue(key: string, linkedKey: string): void;
  /** Move a blocker to a new status (and optionally set that status's category). */
  moveBlocker(blockerKey: string, status: string, category?: StatusCategoryKey): void;
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
  let expectedAuthHeader: string | null = null; // feature 005: /myself auth check
  let botDisplayName = 'BRIGADIR Bot';
  let armed500Statuses = false;
  let armed500IssueGet = false;

  const catOf = (status: string): StatusCategoryKey => category[status] ?? 'indeterminate';

  const linkFor = (blockerKey: string): JiraIssueLink => {
    const blocker = issues.get(blockerKey);
    const status = blocker
      ? { name: blocker.statusName, statusCategory: { key: catOf(blocker.statusName) } }
      : { name: 'Unknown', statusCategory: { key: 'indeterminate' as StatusCategoryKey } };
    return {
      type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      inwardIssue: { key: blockerKey, fields: { status } },
    };
  };

  const toJiraIssue = (i: StoredIssue): JiraIssue => ({
    key: i.key,
    id: i.id,
    fields: {
      summary: i.summary,
      status: { name: i.statusName, statusCategory: { key: catOf(i.statusName) } },
      updated: i.updated,
      issuelinks: i.blockedBy.map(linkFor),
    },
  });

  /**
   * Apply the structured subset of the poller JQL the mock understands:
   * `updated >= "X"`, `sprint in (…)`, `key in (…)`, `labels = X` / `labels in (…)`.
   * Everything else (project clause, ORDER BY) is ignored.
   */
  const matchesJql = (i: StoredIssue, jql: string): boolean => {
    const upd = jql.match(/updated\s*>=\s*"([^"]+)"/i);
    if (upd) {
      // Mirror LIVE Jira (incident 2026-07-13): JQL datetime literals accept ONLY
      // `yyyy-MM-dd HH:mm` (or bare `yyyy-MM-dd`). An ISO string with T/Z/millis is
      // NOT a 400 — the live /search/jql answers HTTP 200 with ZERO issues. The mock
      // must be exactly this unforgiving, otherwise a bad `since` format passes every
      // test while silently killing incremental polling in production.
      if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(upd[1])) return false;
      const bound = Date.parse(upd[1].includes(' ') ? upd[1].replace(' ', 'T') + ':00Z' : upd[1]);
      if (!Number.isNaN(bound) && Date.parse(i.updated) < bound) return false;
    }
    const sprint = jql.match(/sprint\s+in\s*\(([^)]*)\)/i);
    if (sprint) {
      const ids = sprint[1]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
      if (i.sprintId == null || !ids.includes(i.sprintId)) return false;
    }
    const keyIn = jql.match(/key\s+in\s*\(([^)]*)\)/i);
    if (keyIn) {
      const keys = keyIn[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      if (!keys.includes(i.key)) return false;
    }
    const labelEq = jql.match(/labels\s*=\s*"?([\w-]+)"?/i);
    if (labelEq && !i.labels.includes(labelEq[1])) return false;
    const labelIn = jql.match(/labels\s+in\s*\(([^)]*)\)/i);
    if (labelIn) {
      const wanted = labelIn[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      if (!i.labels.some((l) => wanted.includes(l))) return false;
    }
    return true;
  };

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
    // --- POST /rest/api/3/search/jql (JQL scope + nextPageToken pagination) ---
    http.post(`${baseUrl}/rest/api/3/search/jql`, async ({ request }) => {
      const r = maybe429();
      if (r) return r;
      const body = (await request.json()) as { jql?: string; fields?: string[]; nextPageToken?: string };
      const jql = body.jql ?? '';
      const all = [...issues.values()]
        .filter((i) => matchesJql(i, jql))
        .sort((a, b) => a.key.localeCompare(b.key));
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

    // --- single issue (context for transition discovery + feature-context read) ---
    http.get(`${baseUrl}/rest/api/3/issue/:key`, ({ params }) => {
      const r = maybe429();
      if (r) return r;
      if (armed500IssueGet) {
        armed500IssueGet = false;
        return HttpResponse.json({ errorMessages: ['boom'] }, { status: 500 });
      }
      const issue = issues.get(params.key as string);
      if (!issue) return HttpResponse.json({ errorMessages: ['not found'] }, { status: 404 });
      const epic = issue.epicKey ? issues.get(issue.epicKey) : undefined;
      const linkRef = (linkedKey: string) => {
        const linked = issues.get(linkedKey);
        return {
          key: linkedKey,
          fields: {
            status: { name: linked?.statusName ?? '', statusCategory: { key: catOf(linked?.statusName ?? '') } },
            summary: linked?.summary ?? null,
          },
        };
      };
      return HttpResponse.json({
        key: issue.key,
        id: issue.id,
        fields: {
          status: { name: issue.statusName, statusCategory: { key: catOf(issue.statusName) } },
          issuetype: { name: issue.issueType },
          project: { key: projectKey },
          summary: issue.summary,
          description: issue.description ?? null,
          parent: epic ? { key: epic.key, fields: { status: { name: epic.statusName } } } : undefined,
          issuelinks: issue.linked.map((linkedKey) => ({ outwardIssue: linkRef(linkedKey) })),
          // feature 011 (read tools): labels + the comments captured by the
          // write path, oldest-first like live Jira.
          labels: issue.labels ?? [],
          // feature 020: component objects as live Jira serves them ({name}).
          components: (issue.components ?? []).map((name) => ({ name })),
          comment: {
            comments: (comments.get(issue.key) ?? []).map((body, i) => ({
              author: { displayName: 'Mock Commenter' },
              created: `2026-07-16T00:0${i % 10}:00.000Z`,
              body,
            })),
          },
        },
      });
    }),

    // --- feature 005: identity (wizard Verify) ---
    http.get(`${baseUrl}/rest/api/3/myself`, ({ request }) => {
      if (expectedAuthHeader && request.headers.get('Authorization') !== expectedAuthHeader) {
        return HttpResponse.json({ errorMessages: ['Unauthorized'] }, { status: 401 });
      }
      return HttpResponse.json({ displayName: botDisplayName });
    }),

    // --- feature 005: project statuses (grouped by issue type; flattened client-side) ---
    http.get(`${baseUrl}/rest/api/3/project/:key/statuses`, () => {
      if (armed500Statuses) {
        armed500Statuses = false;
        return HttpResponse.json({ errorMessages: ['boom'] }, { status: 500 });
      }
      const statuses = Object.keys(category).map((name) => ({
        id: `s-${name}`,
        name,
        statusCategory: { key: catOf(name) },
      }));
      // Two issue-type groups repeating the same statuses → exercises de-dup by id.
      return HttpResponse.json([
        { id: '1', name: 'Task', statuses },
        { id: '2', name: 'Bug', statuses },
      ]);
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
        description: opts.description,
        statusName: opts.status,
        updated: opts.updated ?? new Date().toISOString(),
        issueType: opts.issueType ?? 'Task',
        sprintId: opts.sprintId,
        labels: opts.labels ?? [],
        components: opts.components ?? [],
        blockedBy: [],
        linked: [],
      });
    },
    setStatus(key, status) {
      const i = issues.get(key);
      if (i) i.statusName = status;
    },
    setComponents(key, components) {
      const i = issues.get(key);
      if (i) i.components = components;
    },
    setCategory(status, cat) {
      category[status] = cat;
    },
    expectAuth(email, apiToken) {
      expectedAuthHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
    },
    setBotDisplayName(name) {
      botDisplayName = name;
    },
    arm500OnStatuses() {
      armed500Statuses = true;
    },
    arm500OnNextIssueGet() {
      armed500IssueGet = true;
    },
    addBlockedByLink(key, blockerKey) {
      const issue = issues.get(key);
      if (!issue) throw new Error(`seed the blocked issue before linking (${key})`);
      if (!issues.has(blockerKey)) throw new Error(`seed the blocker before linking (${blockerKey})`);
      issue.blockedBy.push(blockerKey);
    },
    setEpic(key, epicKey) {
      const issue = issues.get(key);
      if (!issue) throw new Error(`seed the issue before setting its epic (${key})`);
      if (!issues.has(epicKey)) throw new Error(`seed the epic before linking (${epicKey})`);
      issue.epicKey = epicKey;
    },
    addLinkedIssue(key, linkedKey) {
      const issue = issues.get(key);
      if (!issue) throw new Error(`seed the issue before linking (${key})`);
      if (!issues.has(linkedKey)) throw new Error(`seed the linked issue before linking (${linkedKey})`);
      issue.linked.push(linkedKey);
    },
    moveBlocker(blockerKey, status, cat) {
      const i = issues.get(blockerKey);
      if (i) i.statusName = status;
      if (cat) category[status] = cat;
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
      expectedAuthHeader = null;
      botDisplayName = 'BRIGADIR Bot';
      armed500Statuses = false;
      armed500IssueGet = false;
      for (const k of Object.keys(category)) {
        if (!(k in DEFAULT_CATEGORY)) delete category[k];
        else category[k] = DEFAULT_CATEGORY[k];
      }
    },
  };
}
