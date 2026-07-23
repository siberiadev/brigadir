# Migration Review — `0009_agent_instructions.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0008` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-23 · **Migration**: `drizzle/0009_agent_instructions.sql` ·
**Change**: one nullable sealed-token column on `workspaces` — feature 030
(agent role-template source): `agent_instructions_token bytea`.

## Line-by-line vs §3

| SQL | §3 line | Verdict |
|---|---|---|
| `ADD COLUMN "agent_instructions_token" "bytea"` | `agent_instructions_token bytea` — sealed токен приватного репо шаблонов ролей (AES-256-GCM, ключ BRIGADIR_CREDENTIALS_KEY); NULL = нет токена; write-only | ✓ match (nullable by default — §3 has no NOT NULL; NULL is the correct initial value for every existing row) |

## Notes

- Pure additive DDL from `drizzle-kit generate` (schema delta in
  `libs/database/src/schema/workspaces.ts`); `meta/0009_snapshot.json` +
  `_journal.json` from the same run. No backfill: NULL ("no token") is correct
  for every existing row.
- Same envelope + key as `jira_credentials` / `executors.secrets`
  (`sealSecret`/`openSecret`, `BRIGADIR_CREDENTIALS_KEY`) — Constitution V, one
  codec, one key. The non-secret `git_url`/`git_ref`/`subdir` live in
  `workspaces.settings.agent_instructions` (jsonb), NOT here — a token must
  never enter a blob that is serialized into API responses.
- Write-only at the API boundary: responses expose only
  `has_agent_instructions_token`; the plaintext is opened solely inside the
  backend template-fetch path and delivered to git via an ephemeral child-env
  header (never argv, never the agent's env).
- No index: the column is read only by id (the workspace's own row) during
  source resolution.
