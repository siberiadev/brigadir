# Quickstart: validating 016-ui-polish-role-queue

Validation guide for the four changes. Details: [spec.md](spec.md), [data-model.md](data-model.md), [contracts/human-tasks-ordering.md](contracts/human-tasks-ordering.md).

## Prerequisites

- `pnpm install` done; Docker running (integration tests use testcontainers).
- For manual UI validation: full stack up — `docker compose up --build`, or dev mode per `docs/local-setup.md`.

## Automated validation (primary)

```bash
# Static + unit + web component tests (covers Runs Role column, Agents Role/Executor columns, queue rendering)
pnpm typecheck && pnpm lint && pnpm test

# Integration tests (covers the newest-first ordering contract; needs Docker)
pnpm test:integration
```

Expected outcomes:

- `apps/web/test/runs-table.spec.ts` — Role column renders the agent's role; a run whose agent has no role shows `—`.
- `apps/web/test/agents-columns.spec.ts` (new) — Name cell contains only the persona name (no `(role)` suffix); Role column shows an `el-tag` with the role, empty cell when role absent; Executor column shows the executor profile **name** (never a UUID), empty cell for an unresolvable `executor_id`.
- `apps/web/test/human-queue.spec.ts` — open tab renders items in server-given (newest-first) order.
- `test/integration/human-queue.spec.ts` — open list returns newest-first (`created_at DESC, id DESC`), same-instant tasks in stable order; closed list still `resolved_at DESC`; both with and without `?workspace=`.

## Manual validation (spot-check in the browser)

Stack up, dashboard open, workspace with agents/runs/human tasks present:

1. **Runs Role column** — Workspace → Runs tab: table has a "Role" column; runs from role-less agents show `—`; all pre-existing columns (Agent, Ticket, Status, Attempt, Duration, Cost) intact.
2. **Queue ordering** — trigger/park several runs so open human tasks exist. Global `/human-queue` OPEN tab: most recently created task is row 1. Workspace → Human queue tab: identical order. Resolve a task → History tab still lists most-recently-resolved first.
3. **Agents columns** — Workspace → Agents tab: Name shows only the persona name; separate Role column shows a tag (empty for role-less agents); Key column unchanged; Executor column shows profile names like `claude-default`, never a UUID. Kill the backend executors briefly / use an agent with a dangling executor_id → Executor cell empty, table still renders.
4. **Conventions** — tag colors come from the amber theme automatically (no hardcoded colors in the diff); pagination components untouched; no new animated icons.

## Success criteria mapping

| Spec criterion | Validated by |
|---|---|
| SC-001 newest open task on top, both places | integration ordering tests + manual step 2 |
| SC-002 role/executor readable from lists, consistent fallbacks | web component tests + manual steps 1, 3 |
| SC-003 no dup/skip across pages | integration tie-breaker test |
| SC-004 no regressions (History order, existing columns) | existing suites staying green + manual steps 1-3 |
