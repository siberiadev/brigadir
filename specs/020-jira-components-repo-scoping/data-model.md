# Data Model: Per-Ticket Repository Scoping via Jira Components

**Feature**: 020 | **Date**: 2026-07-18 | **Plan**: [plan.md](plan.md)

**No DDL in this feature.** Every addition is a jsonb value, a zod contract field, or an
in-memory type. `docs/architecture.md` §3 stays untouched (CLAUDE.md rule 5 satisfied by
construction).

## 1. `WorkspaceSettings.ticket_scoping` (jsonb value, contracts)

`packages/contracts/src/jira.types.ts` → `WorkspaceSettingsSchema`:

| Field | Type | Semantics |
|---|---|---|
| `ticket_scoping` | `z.boolean().optional()` | D2b rollout flag. **Absent ⇒ OFF** (byte-identical legacy behavior). Read per run at scope resolution; never at module composition. |

Precedents in the same blob: `enabled` (feature 006), `rework_max` (feature 010).
Accessor: extend `libs/database/src/workspace-settings.ts` with
`getTicketScoping(db, workspaceId): Promise<boolean>` (absent ⇒ `false`) — or read it off
the settings row the executor already loads in `resolveRepositories` (no extra query;
implementation's choice, but only ONE read path).

Dashboard contract (`packages/contracts/src/dashboard.schema.ts`), additive and optional:

- `WorkspaceSettingsRequestSchema` += `ticket_scoping: z.boolean().optional()` (PUT absent ⇒ unchanged).
- `WorkspaceResponseSchema` += `ticket_scoping: z.boolean()` (absent settings key serialized as `false`).

## 2. Ticket components on the run context (in-memory types)

| Type | Field | Notes |
|---|---|---|
| `JiraClient.getIssue` return | `components: string[]` | Component **names**; Jira field absent ⇒ `[]`. |
| `TicketDetail` (`apps/worker/src/ticket-detail.ts`) | `components: string[] | null` | `null` = fetch failed (R5); `[]` = ticket has none. |
| `RunContext.ticket` (`libs/executors/src/agent-executor.interface.ts`) | `components: string[] | null` | Same semantics; `ticket` itself stays `… | null` for ticketless runs. |

Validation rules: names are used as opaque strings; matching normalizes by
`trim().toLowerCase()` (spec FR-016). No length/charset validation — Jira owns the vocabulary.

## 3. Scope resolution result (in-memory, pure — `scope-ticket.ts`)

```
type ScopeCase = 'no_components' | 'no_repo_components' | 'outside_agent_scope';

interface NarrowingDecision {              // recorded verbatim in the run event (R6)
  components: string[] | null;             // as seen on the ticket
  matched: string[];                       // components that named a workspace repository
  ignored: string[];                       // components filtered silently (D3)
  effective: string[];                     // final repo names the run mounts
  gate: 'off' | 'skipped_single_repo' | 'passed' | `parked:${ScopeCase}` | 'failed:components_unreadable';
}

type NarrowResult =
  | { kind: 'resolved'; repos: WorktreeRepo[]; decision: NarrowingDecision }
  | { kind: 'undeterminable'; case: ScopeCase; decision: NarrowingDecision }
  | { kind: 'components_unreadable'; decision: NarrowingDecision };  // gate 'failed:components_unreadable' — uniform event recording
```

`RepositoryScopeUndeterminableError` (thrown by the executor, caught by the processor — R4)
carries: `case: ScopeCase`, `ticketKey`, `components: string[]`, `agentRepoNames: string[]`,
`workspaceRepoNames: string[]` — display-safe fields only (FR-009).

State invariants (D1/D2a/D2b/D3 — full table in [contracts/scope-resolution.md](contracts/scope-resolution.md)):

- `effective ⊆ base set` always (never widens).
- `kind: 'undeterminable'` only when `scopingEnabled && baseRepos.length ≥ 2`.
- `case` classification order: no components → 1; no component matches ANY workspace repo → 2;
  matches exist but ∩ base set = ∅ → 3.

## 4. Human task row (existing table, new producer — no shape change)

`human_tasks` insert via `HumanTaskService.createFromRequest` with:

| Column | Value |
|---|---|
| `kind` | `'blocker'` |
| `blocking` | `true` (drives guarded park → `awaiting_human` + Jira transition/comment) |
| `title` / `details` | System-composed per D2 case from fixed templates + ticket key, component names, repository names only (see [contracts/scope-resolution.md](contracts/scope-resolution.md) §Question texts) |
| `options` | not passed (NULL) — system-composed precedent, feature 010 |

Existing dedup (one open task per run) and the `status='running'` park guard apply unchanged.

## 5. Run event (existing table, new payload shape)

One `run_events` row per scoping-active resolution, `type: 'log'`:

```
payload: {
  source: 'repo-scoping',
  message: string,               // human-readable one-liner for the timeline
  ...NarrowingDecision           // components / matched / ignored / effective / gate
}
```

Precedent: `setup-profile-fallback` event (`claude-cli.executor.ts:680`).

## 6. Run state transitions (existing machine, no new states)

- Gate parks: `running → awaiting_human` (guarded `WHERE status='running'`, existing `parkRun`).
- Task resolved: `awaiting_human → superseded` + fresh `queued` run (existing `ResumeService` transaction; passes `runs_one_active`).
- Components unreadable under an active gate: `running → failed` (diagnostics via existing crashed mapping).
