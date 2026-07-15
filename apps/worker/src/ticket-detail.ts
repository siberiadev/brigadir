import type { Logger } from '@nestjs/common';
import { type JiraClientFactory, jiraDescriptionToMarkdown } from '@brigadir/jira';

/** Fetched-at-dispatch ticket detail for RunContext (description as markdown + browse URL). */
export interface TicketDetail {
  description: string;
  url: string;
}

/**
 * Fetch the ticket's description at run dispatch (docs/spec.md — "description
 * как markdown"), shared by both run processors (same pattern as
 * executor-gate.ts). The description lives in Jira only — the poller caches
 * status/summary, never bodies — so it is read lazily per dispatch via the
 * per-workspace client. A Jira failure MUST NOT fail the job (same idiom as
 * pipeline.onRunStarted): the run proceeds with an empty description. The
 * browse URL is derived from the DB row OUTSIDE the try — a Jira outage still
 * yields a correct link.
 */
export async function fetchTicketDetail(
  jiraFactory: JiraClientFactory,
  logger: Logger,
  loaded: { runId: string; workspaceId: string; ticketKey: string; jiraSiteUrl: string },
): Promise<TicketDetail> {
  const url = `${loaded.jiraSiteUrl.replace(/\/+$/, '')}/browse/${loaded.ticketKey}`;
  try {
    const jira = await jiraFactory.forWorkspace(loaded.workspaceId);
    const issue = await jira.getIssue(loaded.ticketKey);
    return { description: jiraDescriptionToMarkdown(issue.description), url };
  } catch (err) {
    logger.warn(
      `ticket detail fetch failed for run ${loaded.runId} (${loaded.ticketKey}): ${String(err)} — continuing with empty description`,
    );
    return { description: '', url };
  }
}
