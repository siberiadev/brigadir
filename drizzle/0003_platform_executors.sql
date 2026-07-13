ALTER TABLE "executors" DROP CONSTRAINT "executors_workspace_name";--> statement-breakpoint
ALTER TABLE "executors" DROP CONSTRAINT "executors_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "executors" DROP COLUMN "workspace_id";--> statement-breakpoint
-- Defensive dedupe before the GLOBAL unique on name: executors were previously
-- unique per (workspace_id, name), so two workspaces could hold the same name.
-- Keep one row per name untouched and suffix every later duplicate with a short
-- id fragment (deterministic: rows ordered by id; ids and agent FKs unchanged).
UPDATE "executors" e
SET "name" = e."name" || '-' || left(e."id"::text, 8)
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "name" ORDER BY "id") AS rn
  FROM "executors"
) ranked
WHERE ranked."id" = e."id" AND ranked.rn > 1;--> statement-breakpoint
ALTER TABLE "executors" ADD CONSTRAINT "executors_name" UNIQUE("name");
