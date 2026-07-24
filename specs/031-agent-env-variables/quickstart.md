# Quickstart: validating env variables for agent runs

End-to-end validation guide for feature 031. Shapes and rules referenced from [contracts/env-config.md](contracts/env-config.md) and [data-model.md](data-model.md).

## Prerequisites

- Docker running (testcontainers + compose stack)
- `.env` populated per `docs/local-setup.md` (incl. `BRIGADIR_CREDENTIALS_KEY`)
- Stack up: `docker compose up --build` (or dev-mode backend+worker)
- A workspace with ≥1 repository and ≥1 enabled agent on a `claude_cli`-family executor

## Gates (must pass before and after every story)

```bash
pnpm typecheck && pnpm lint && pnpm test   # statics + units + web
pnpm test:integration                       # real Postgres/Redis
```

## Scenario A — plain env reaches the run (US1)

1. Settings → Environment defaults: add `NODE_ENV=test`. Repositories block → edit the default repo card: add `PORT=3100`.
2. Trigger a run for an agent mounting that repo (move its ticket into the trigger status, or manual trigger).
3. In the run timeline, have the agent's task include `env | grep -E 'NODE_ENV|PORT'` (or configure a diagnostic instruction). Expected: `NODE_ENV=test`, `PORT=3100`.
4. Repo-level override check: set repo `NODE_ENV=e2e`, rerun → run observes `e2e` (repo beats workspace).
5. Automated: executor spec with `FAKE_CLAUDE_ENV_DUMP` asserts merged env + precedence; integration test drives config → run → dumped env.

## Scenario B — secrets are write-only and scrubbed (US2)

1. Edit repo card → add `DATABASE_URL=postgres://user:s3cretpw@dbhost:5432/app`, mark **secret**, save.
2. Verify masking: card summary shows "… 1 secret"; reopening the dialog shows the key with `••••` and no reveal; `GET /api/workspaces/:id` response contains the key name under `env_secret_keys` and NOT the value (curl/jq).
3. Run the agent with a task that uses `DATABASE_URL` (e.g. `psql "$DATABASE_URL" -c 'select 1'` against a test DB). Expected: command works.
4. Leak sweep after the run completes:
   ```bash
   # value must appear nowhere; expect all three to return no rows
   psql $DB -c "select id from run_events where payload::text like '%s3cretpw%'"
   psql $DB -c "select id from runs where report::text like '%s3cretpw%' or error like '%s3cretpw%'"
   # plus: check the Jira issue comments manually or via API for the literal
   ```
5. Edit flow: replacing requires re-entering a value; delete removes the key (verify `env_secret_keys` shrinks).

## Scenario C — settings UI restructure (US3)

1. Create a NEW workspace via the creation flow — repository rows behave exactly as before (no env fields).
2. Workspace settings shows the Repositories card block (name, URL, branch, Default tag, env summary) and the Environment defaults block.
3. Workspace edit dialog no longer contains repository rows.
4. Card dialog: reserved key `ANTHROPIC_API_KEY` → inline error naming the key; malformed `2FOO` → inline error; server rejects the same via curl (400, message names the key).
5. "Make default" action moves a card to index 0; runs pick the new default repo.

## Scenario D — per-agent override (US4)

1. Agent form → advanced section → add `NODE_ENV=e2e` on the QA agent only; row shows an "overrides" badge (workspace has `NODE_ENV=test`).
2. Run QA agent and another agent against the same repo: QA run sees `e2e`, the other sees `test`.

## Scenario E — admin-MCP parity (US5)

1. Export a secret before launching Claude Code: `export STAGING_DB_URL=...` (add to `.env` per admin-MCP setup).
2. In a Claude Code session with `brigadir-admin`: create a workspace whose repository carries `env: [{key: 'PORT', value: '3100'}, {key: 'DATABASE_URL', secret_from_env: 'STAGING_DB_URL'}]`.
3. `set_env` on the existing workspace: add/delete keys at all three scopes; verify via workspace read (masked) and a subsequent run.
4. Inspect the session transcript: the literal secret value appears nowhere (only the name `STAGING_DB_URL`).
5. Negative: reference a missing `secret_from_env` variable → tool error naming it; nothing partially applied.

## Scenario F — guarantees & regressions

1. **Fixation**: start a long run, change `PORT`, confirm the live run still sees the old value; next run sees the new one.
2. **No-repo runs**: trigger an orchestrator triage run — it must observe NONE of the configured env.
3. **Allowlist floor**: extended T085-style executor test proves a host-only variable never leaks, with user env configured.
4. **Zero-config regression**: workspace without env → child env identical to pre-feature (snapshot comparison in executor spec).
5. **Fail-fast**: corrupt `env_secrets` (flip a byte in a test DB) → run fails before spawn with a diagnostic naming the workspace; no agent process starts.

## Success criteria mapping

| Scenario | Spec criteria |
|---|---|
| A | SC-001 (partial), SC-002, US1 |
| B | SC-003, US2, FR-005..008 |
| C | SC-004, US3, FR-009..011 |
| D | US4, FR-012 |
| E | US5, FR-013 |
| F | SC-002, SC-005, FR-002..004, FR-014..015 |
