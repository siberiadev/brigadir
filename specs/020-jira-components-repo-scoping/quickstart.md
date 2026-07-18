# Quickstart: validating per-ticket repository scoping

**Feature**: 020 | **Plan**: [plan.md](plan.md) | **Contracts**: [contracts/](contracts/)

## Prerequisites

- Docker running (integration tests use testcontainers; shared containers per
  `test/integration/global-setup.ts`).
- `pnpm install` done at repo root.

## 1. Static + unit (fast loop)

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Must include (new):

- `libs/executors/src/claude-cli/scope-ticket.spec.ts` — one test per row of the
  [decision table](contracts/scope-resolution.md#decision-table-normative--one-unit-test-per-row-minimum):
  flag off; single-repo skip (D2a); unreadable components; the three park cases (D2);
  partial match with ignored non-repo names (D3); never-widens (D1); deprecated-field
  agent; case/whitespace matching (FR-016).
- `wrapper.spec.ts` — snapshot: non-narrowed run byte-identical; narrowed run lists
  excluded repos with the `.repos/<name>` note (D4).
- Updated `basic-auth-jira.client.spec.ts` / `lazy-jira.client.spec.ts` — `getIssue`
  requests and maps `components`.

## 2. Integration (testcontainers — real Postgres/Redis)

```bash
pnpm test:integration
```

New coverage, modeled on `test/integration/claude-cli-repository.spec.ts` (harness:
`claude-cli-harness.ts`, Jira double: `mock-jira.ts`):

| Scenario | Expected | Spec ref |
|---|---|---|
| Flag ON, components name subset of a multi-repo agent's scope | worktrees created ONLY for the subset; run event `gate:'passed'` with matched/ignored lists | Story 1, SC-001 |
| Flag ON, components include a non-repo name alongside a match | non-repo name ignored, run proceeds | FR-004 |
| Flag ON, components name repos outside agent scope + one inside | only the inside repo mounted (never widens) | FR-003 |
| Flag ON, each of: no components / only non-repo components / disjoint-from-scope components | run parks `awaiting_human`, `human_tasks` row `kind:'blocker'` with the case's distinct title; Jira double sees blocked transition + comment; NO clone performed | FR-007/008, SC-002 |
| Flag ON, single-repo base set, no components | no park, run proceeds with that repo | FR-006, Story 4 |
| Flag ON, Jira `getIssue` fails | run `failed` with diagnostics (no park, no full-set clone) | R5 |
| Flag OFF (default), full matrix: with/without components, deprecated `behavior.repository`, repo-less, setup run | byte-identical to today; existing specs pass unmodified | FR-005, SC-003 |
| Park → set components on the Jira double → resolve task | parked run `superseded`, fresh `queued` run re-reads components and mounts the subset | FR-011, SC-004 |
| Setup run in a flag-ON workspace | unchanged one-element scope, gate never fires | FR-013 |

Also verify: parking respects the `status='running'` guard (reuse the idiom from
`callback-awaiting-human-noclobber.spec.ts`).

## 3. Manual smoke (full stack, optional)

```bash
docker compose up --build
```

1. In the dashboard, open a workspace's Settings tab → enable "Ticket repository scoping".
2. On the Jira board, create a ticket with Components = one repository name; move it to an
   agent's trigger status → run's timeline shows the `repo-scoping` event; workspace dir
   contains only that repo's worktree.
3. Create a ticket with no Components → run parks; Human Queue shows the case-1 question;
   ticket transitions to the blocked status with the question comment.
4. Set Components on the ticket, resolve the task → new run proceeds scoped.
5. Toggle the flag off → same tickets run exactly as before the feature.

## Done when

All boxes in the table above green, `pnpm typecheck && pnpm lint && pnpm test` and
`pnpm test:integration` pass, and the flag-off matrix shows zero diffs from today
(constitution VI: tests ship in this same iteration).
