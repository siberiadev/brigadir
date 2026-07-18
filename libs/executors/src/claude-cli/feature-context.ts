import { and, desc, eq } from 'drizzle-orm';
import { type BrigadirDb, schema } from '@brigadir/database';
import type { JiraClient } from '@brigadir/jira';
import { normalizeReportArtifacts, type AgentReport } from '@brigadir/contracts';

/**
 * Wrapper feature-context section (feature 004 US6, D5, FR-026). Compiles
 * the ticket's epic + linked-issue statuses (JiraClient.getFeatureContext,
 * T114) plus branch/PR URLs extracted from the most recent run's report on
 * each linked issue, within a hard size budget. Wired only for
 * callback-wired runs (claude-cli.executor.ts).
 */

const MAX_LINKED_ISSUES = 20;
const SUMMARY_MAX_CHARS = 80;
const LINE_MAX_CHARS = 200;
const SECTION_MAX_BYTES = 2048;

/** Per-repo branch/PR lines from a linked issue's latest report (feature 019). */
interface LinkedArtifacts {
  entries: { repo?: string; branch?: string; pr_url?: string }[];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function latestArtifacts(
  db: BrigadirDb,
  workspaceId: string,
  ticketKey: string,
): Promise<LinkedArtifacts | undefined> {
  const rows = await db
    .select({ report: schema.runs.report })
    .from(schema.runs)
    .innerJoin(schema.tickets, eq(schema.runs.ticketId, schema.tickets.id))
    .where(and(eq(schema.tickets.workspaceId, workspaceId), eq(schema.tickets.jiraKey, ticketKey)))
    .orderBy(desc(schema.runs.createdAt))
    .limit(5);

  for (const row of rows) {
    const report = row.report as AgentReport | null;
    if (!report) continue;
    // Feature 019: the shared normalizer handles both the legacy flat form
    // and artifacts.repos[] — a multi-repo prior run surfaces EVERY branch/PR.
    const entries = normalizeReportArtifacts(report)
      .filter((a) => a.branch || a.pr_url)
      .map((a) => ({ repo: a.repo, branch: a.branch, pr_url: a.pr_url }));
    if (entries.length > 0) return { entries };
  }
  return undefined;
}

export async function buildFeatureContextSection(
  deps: { jira: JiraClient; db: BrigadirDb },
  ticketKey: string,
  workspaceId: string,
): Promise<string | undefined> {
  let ctx: Awaited<ReturnType<JiraClient['getFeatureContext']>>;
  try {
    ctx = await deps.jira.getFeatureContext(ticketKey);
  } catch {
    // Best-effort — a Jira hiccup must never block a run over wrapper context.
    return undefined;
  }
  if (!ctx.epic && ctx.linked.length === 0) return undefined;

  const totalLinked = ctx.linked.length;
  let shown = ctx.linked.slice(0, MAX_LINKED_ISSUES);

  const artifactsByKey = new Map<string, LinkedArtifacts>();
  for (const issue of shown) {
    const artifacts = await latestArtifacts(deps.db, workspaceId, issue.key);
    if (artifacts) artifactsByKey.set(issue.key, artifacts);
  }

  const render = (issues: typeof shown, includeArtifacts: boolean): string => {
    const droppedCount = totalLinked - issues.length;
    const lines: string[] = ['## Feature context'];
    if (ctx.epic) lines.push(`Epic: ${ctx.epic.key} [${ctx.epic.status}]`);
    if (issues.length > 0) {
      lines.push('', 'Linked issues:');
      for (const issue of issues) {
        lines.push(`- ${issue.key} [${issue.status}] ${truncate(issue.summary, SUMMARY_MAX_CHARS)}`);
        if (includeArtifacts) {
          const artifacts = artifactsByKey.get(issue.key);
          for (const entry of artifacts?.entries ?? []) {
            // Feature 019: multi-repo entries are prefixed with the repo name.
            const prefix = entry.repo ? `${entry.repo}: ` : '';
            if (entry.branch) lines.push(truncate(`  branch: ${prefix}${entry.branch}`, LINE_MAX_CHARS));
            if (entry.pr_url) lines.push(truncate(`  PR: ${prefix}${entry.pr_url}`, LINE_MAX_CHARS));
          }
        }
      }
      if (droppedCount > 0) lines.push(`…and ${droppedCount} more`);
    }
    return lines.join('\n');
  };

  const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= SECTION_MAX_BYTES;

  let text = render(shown, true);
  if (!fits(text)) {
    text = render(shown, false); // drop prior-run artifacts first
  }
  while (!fits(text) && shown.length > 0) {
    shown = shown.slice(0, -1); // then truncate the issue list further
    text = render(shown, false);
  }

  return text;
}
