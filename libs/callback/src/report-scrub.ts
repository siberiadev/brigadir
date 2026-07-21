import { scrub } from '@brigadir/scrubber';
import type { AgentReport, AnswerOption } from '@brigadir/contracts';

/**
 * Field-aware report scrubbing (Constitution V). Extracted from
 * `callback.service.ts` (feature 026, research D10) so every path that
 * persists an agent report — the live callback AND the worker reconcile
 * paths (exit-time completed/timed_out, periodic reconciler,
 * undelivered_report events) — passes through ONE audit point.
 *
 * Only free-text, agent-authored fields are scrubbed; structural values
 * (commit SHAs, branch names, agent/executor identifiers) are left intact —
 * a naive deep-scrub would mangle them via the entropy heuristic.
 */

// feature 013 (Constitution V): option texts are free text and reach
// persistence + the Jira question comment, so every field is scrubbed —
// the same guarantee as title/details.
export function scrubOptions(options: AnswerOption[] | undefined): AnswerOption[] | undefined {
  return options?.map((option) => ({
    ...option,
    label: scrub(option.label),
    value: option.value !== undefined ? scrub(option.value) : option.value,
    description: option.description !== undefined ? scrub(option.description) : option.description,
  }));
}

export function scrubAgentReport(report: AgentReport): AgentReport {
  return {
    ...report,
    summary: scrub(report.summary),
    checks: report.checks.map((check) => ({
      ...check,
      reason: check.reason !== undefined ? scrub(check.reason) : check.reason,
    })),
    human_task: report.human_task
      ? {
          ...report.human_task,
          title: scrub(report.human_task.title),
          details: report.human_task.details !== undefined ? scrub(report.human_task.details) : report.human_task.details,
          options: scrubOptions(report.human_task.options),
        }
      : report.human_task,
    // feature 010 (FR-003, Constitution V): the routing task is free text and
    // reaches persistence + the Jira routing comment, so it is scrubbed like
    // every other report field. `target_agent` is a bounded agent name, not
    // free prose — left as-is (it is validated against the roster downstream).
    routing: report.routing
      ? { ...report.routing, task: scrub(report.routing.task) }
      : report.routing,
    // feature 011 (FR-018): proposal free text is scrubbed before persistence /
    // agent-row insert; identifiers (name, statuses, executor) are validated
    // against workspace state instead, mirroring `target_agent`.
    team: report.team
      ? {
          agents: report.team.agents.map((a) => ({
            ...a,
            description: scrub(a.description),
            instruction: scrub(a.instruction),
          })),
        }
      : report.team,
    // feature 019 (research D7, Constitution V): artifact strings are
    // agent-authored and reach persistence + the Jira comment + the dashboard
    // card, so BOTH forms are scrubbed — the flat legacy fields (previously
    // missed entirely) and every repos[] entry. files_changed is numeric.
    artifacts: report.artifacts
      ? {
          ...report.artifacts,
          branch: report.artifacts.branch !== undefined ? scrub(report.artifacts.branch) : undefined,
          pr_url: report.artifacts.pr_url !== undefined ? scrub(report.artifacts.pr_url) : undefined,
          commits: report.artifacts.commits?.map((c) => scrub(c)),
          repos: report.artifacts.repos?.map((r) => ({
            ...r,
            repo: scrub(r.repo),
            branch: r.branch !== undefined ? scrub(r.branch) : undefined,
            pr_url: r.pr_url !== undefined ? scrub(r.pr_url) : undefined,
            commits: r.commits?.map((c) => scrub(c)),
          })),
        }
      : report.artifacts,
  };
}
