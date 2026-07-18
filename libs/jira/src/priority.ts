import type { JiraIssue } from '@brigadir/contracts';

/**
 * Parsed ticket priority cache values (feature 022). Jira's built-in scheme
 * uses numeric string ids ordered Highest("1") → Lowest("5"), so ascending id
 * is descending importance. A custom scheme whose id order differs from its
 * rank order still sorts deterministically (the hard requirement); NULL when
 * the field is absent or the id is not an integer.
 */
export interface ParsedPriority {
  priorityId: number | null;
  priorityName: string | null;
}

export function parseJiraPriority(issue: JiraIssue): ParsedPriority {
  const p = issue.fields.priority;
  if (!p) return { priorityId: null, priorityName: null };
  const id = /^\d+$/.test(p.id) ? Number(p.id) : null;
  return { priorityId: id, priorityName: p.name || null };
}
