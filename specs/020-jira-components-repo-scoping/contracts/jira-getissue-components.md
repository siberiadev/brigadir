# Contract: components through the Jira client and run context

## 1. `JiraClient.getIssue` (extended, backward-compatible)

`libs/jira/src/jira-client.interface.ts:34`, implemented in
`basic-auth-jira.client.ts:157`, delegated in `lazy-jira.client.ts:69`.

```
GET /rest/api/3/issue/{key}?fields=summary,description,components
                                                       ^^^^^^^^^^ added

returns { summary: string | null;
          description: ADFDoc | string | null;
          components: string[] }        // fields.components[].name; absent field ⇒ []
```

- Component objects are mapped to their `name` strings only; ids/self-links dropped.
- `getIssueDetail` (read-tools payload) is NOT extended — no consumer needs it there.
- Test doubles to update in the same change: `test/integration/mock-jira.ts` (+ any
  existing `getIssue` stubs in `basic-auth-jira.client.spec.ts` / `lazy-jira.client.spec.ts`).

## 2. `TicketDetail` (`apps/worker/src/ticket-detail.ts`)

```
interface TicketDetail {
  description: string;
  url: string;
  components: string[] | null;   // null ⇔ the Jira fetch failed (fetch stays non-fatal)
}
```

`fetchTicketDetail` keeps its established failure idiom: on Jira error it logs and returns
`{ description: '', url, components: null }`. `null` vs `[]` is load-bearing (R5): `[]` is
the D2 case-1 signal; `null` means "unknown" and, under an active gate, fails the run
instead of parking with a wrong question.

## 3. `RunContext.ticket` (`libs/executors/src/agent-executor.interface.ts:23`)

```
ticket: {
  key: string;
  summary: string;
  description: string;
  url: string;
  components: string[] | null;   // same semantics as TicketDetail
} | null                          // null for ticketless runs (unchanged)
```

Producers to update: `ClaudeCliRunProcessor.buildContext` (`claude-cli-run.processor.ts:384`)
and `RunProcessor`'s equivalent (`run.processor.ts:233`, mock path — type-complete, no
behavior change, R9). Ticketless runs (`ticket: null`) remain exempt from scoping (spec FR-014).

## 4. Wrapper addendum for narrowed runs (D4/R8)

`libs/executors/src/claude-cli/wrapper.ts`: when (and only when) narrowing excluded at
least one workspace repository, the repo-list header additionally lists the excluded
repositories (name + git URL) with a one-line note that the agent may clone any of them
into `.repos/<name>` on demand if the task turns out to need them. Non-narrowed runs render
byte-identical to today (snapshot-guarded).
