# Migration Review — `0003_platform_executors.sql` vs `docs/architecture.md` §3

**Discipline**: same as `REVIEW-0000` … `REVIEW-0002` — the committed SQL is
reviewed line-by-line against the architecture §3 schema before it is considered
done (Constitution governance / CLAUDE.md rule 5).

**Reviewed**: 2026-07-13 · **Migration**: `drizzle/0003_platform_executors.sql` ·
**Change**: platform-scoped executors (decision 2026-07-13, done outside spec-kit)

## Generated SQL

```sql
ALTER TABLE "executors" DROP CONSTRAINT "executors_workspace_name";
ALTER TABLE "executors" DROP CONSTRAINT "executors_workspace_id_workspaces_id_fk";
ALTER TABLE "executors" DROP COLUMN "workspace_id";
UPDATE "executors" e
SET "name" = e."name" || '-' || left(e."id"::text, 8)
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "name" ORDER BY "id") AS rn
  FROM "executors"
) ranked
WHERE ranked."id" = e."id" AND ranked.rn > 1;
ALTER TABLE "executors" ADD CONSTRAINT "executors_name" UNIQUE("name");
```

The `UPDATE` is hand-added on top of drizzle-kit's generated DDL (kit cannot
express data-dependent steps); everything else is generated.

## Verdict: ✅ MATCHES §3 (executors is now platform-scoped)

| Item | Assessment |
|---|---|
| `workspace_id` column + FK | Dropped — §3 `executors` no longer has it. An executor is PHYSICAL capacity (host CLI binary, subscription/API key); the `run.<type>` queue and the worker's summed concurrency were already platform-global, so the column misstated the scope. |
| `executors_workspace_name` UNIQUE | Replaced by `executors_name` UNIQUE(`name`) — global names, matching §3. |
| Defensive dedupe | Two rows colliding on `name` across former workspaces: the first (by `id` order, deterministic) keeps its name; each later duplicate is suffixed `-<8-char id fragment>`. Row **ids never change**, so `agents.executor_id` needs no rewrite. On the live DB (two uniquely-named executors) this UPDATE touches zero rows. |
| `agents.executor_id` FK | Untouched (stays `REFERENCES executors(id)`, no action). |
| Data loss | None — no row is deleted; a leftover `repository` key inside `config` jsonb is intentionally kept and ignored by the runtime (no data migration). |
| Other tables | Untouched. `0000`–`0002` files unmodified; only `0003_platform_executors.sql`, `meta/0003_snapshot.json`, and `meta/_journal.json` added/updated. |

## Notes (non-deviations)

- Executors previously died with their workspace (`ON DELETE CASCADE`); they now
  outlive workspace deletion — intended: platform capacity is not owned by any
  workspace. The delete-guard (409 `executor_in_use`) still blocks deleting an
  executor referenced by agents in ANY workspace.
- `secrets`/`config`/`concurrency_limit`/`enabled` columns unchanged.
