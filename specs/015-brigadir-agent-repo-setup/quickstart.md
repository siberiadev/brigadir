# Quickstart Validation: Configurable Default Brigadir Agent + Repo-Mounted Setup Runs

**Feature**: 015-brigadir-agent-repo-setup

Prerequisites: Docker running (testcontainers + compose), `.env` per `docs/local-setup.md`, `pnpm i`.

## Gates (must pass before finishing — CLAUDE.md)

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm test:integration   # or the affected suites, see below
```

Affected integration suites: the successor of `global-settings.integration.spec.ts` (new endpoint), `orchestrator-lifecycle.integration.spec.ts` (template-driven seeding), `workspace-setup.integration.spec.ts` (fat-setup environment), `executor-seeding.spec.ts` (brigadir-setup profile).

## Scenario 1 — Template edits seed new workspaces (US1)

1. `docker compose up --build` (or dev-mode backend+worker+web).
2. Open Settings → **Brigadir agent** (third sub-nav item). Expect all fields pre-filled with built-in defaults (see [contracts/brigadir-agent-settings.md](contracts/brigadir-agent-settings.md) GET shape).
3. Change `max_budget_usd` to e.g. `5`, edit the routing instruction, Save.
4. Create a new workspace via the wizard. Open its Agents tab → the seeded `brigadir` agent shows `max_budget_usd = 5` and the edited instruction.
5. Verify a workspace created BEFORE step 3 still has its old orchestrator values (SC-002).
6. API check: `curl -H "Authorization: Bearer $BRIGADIR_DASHBOARD_TOKEN" localhost:3000/api/brigadir-agent-settings` round-trips the saved payload.
7. Negative: PUT with `max_attempts: 0` or `template.triage.executor: "nope"` → 422 with field-level issue.

## Scenario 2 — Fallback on deleted executor (US1, SC-007)

1. In Settings → Executors create a profile `custom-triage`, point the template's triage executor at it, Save.
2. Disable/delete `custom-triage`.
3. Create a workspace → creation succeeds; response/UI toast carries the fallback warning; the seeded orchestrator rides `brigadir-orchestrator`.

## Scenario 3 — Fat setup run with repository recon (US2)

1. Create a workspace with a connected default repository (SSH-reachable from the worker host).
2. Click **Generate agents**.
3. Verify on the run card / `GET /api/runs/:id`:
   - run is ticketless with source `workspace-setup`;
   - worker logs show the setup executor profile (model `claude-sonnet-5`, maxTurns 60 by default) and a mounted worktree (branch `setup/<runId8>`), NOT the scratch no-repo dir;
   - generated agents' instructions reference real repo facts (gate commands, conventions) — SC-003.
4. After the run: worktree and `.repos/*` clones cleaned up; `git branch -a` in the repo cache shows no pushed `setup/*` branch on the remote (SC-005).
5. Trigger a triage run (fail a worker run) → verify it still uses `brigadir-orchestrator` (Haiku, maxTurns 15) with no worktree (SC-004).

## Scenario 4 — Degraded setup environments (US2 edge cases)

1. Workspace with NO repositories → Generate agents → run proceeds repo-less (scratch dir), completes; summary notes recon was skipped.
2. Point `template.setup.executor` at a disabled profile → Generate agents → run proceeds on `brigadir-setup` fallback; run timeline shows the warning event (FR-018).

## Scenario 5 — Instruction relocation + resets (US3)

1. With pre-existing edited instruction values in the DB (edit via old UI before upgrade, or seed `global_settings` keys directly), open Settings → Brigadir agent → both texts show the stored values (SC-006).
2. Per-field Reset on the routing instruction → field reverts to built-in text; button disables when already default; Save persists.
3. **Reset all to defaults** → confirmation dialog → every field reverts; Save persists.
4. Settings → General shows only the Theme radio group; `GET /api/general-settings` → 404.
5. Edit the workspace-setup instruction, Save, then Generate agents in ANY workspace → the run's handoff carries the new text (live-read, spec US3 scenario 5; assertable via the workspace-setup integration suite).

## Web tests

```bash
pnpm --filter web test   # settings-page + new SettingsBrigadirAgent specs
```
