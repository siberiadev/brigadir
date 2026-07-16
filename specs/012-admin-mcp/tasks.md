# Tasks: Admin MCP server `brigadir-admin`

Dependency-ordered. `[P]` = parallelizable with siblings. Tests ship in the same
commit as the code they cover (Constitution VI).

## Phase 1 — Contracts (the single typed source)

- **T001** Add `packages/contracts/src/admin-tools.schema.ts`: `AdminTools` map with
  input+output zod 4 schemas for all 9 tools; reuse `TeamAgentSchema` and
  `WorkspaceRepositorySchema`; every field `.describe(...)`; all objects `.strict()`.
  Export from `index.ts`.
- **T002** Add `packages/contracts/src/admin-tools.schema.spec.ts`: contract tests —
  `z.toJSONSchema(schema,{target:'draft-7'})` does not throw for every input+output;
  descriptions/bounds present; `create_team` input reuses `TeamAgentSchema`;
  `create_workspace` output `enabled` is literally `false`.

## Phase 2 — Backend endpoint (atomic create_team)

- **T003** Refactor `libs/pipeline/src/setup-apply.service.ts`: rename `validate` →
  `validateTeam` (public), extract `insertTeamAgents(tx,…)`; keep `apply()` calling it
  (run path unchanged); add public `createTeamDirect(workspaceId, agents)`.
- **T004** Add `POST /api/workspaces/:id/team` to `workspaces.controller.ts`
  (DashboardTokenGuard): parse `{agents:TeamAgentSchema[1..20]}`, 404/409
  `worker_agents_exist` preconditions, call `createTeamDirect`, map `invalid`→422.
  Wire `SetupApplyService` into `DashboardModule` (import `PipelineModule`). Add the
  `CreateTeamRequestSchema`/response to contracts if needed.
- **T005** Unit/integration: run-path regression stays green; `create_team` atomic
  (invalid mid-list ⇒ 422, zero created); `worker_agents_exist` precondition.

## Phase 3 — The package

- **T006** Scaffold `packages/admin-mcp` (package.json bin `brigadir-admin`,
  tsconfig, vitest.config) mirroring `packages/mcp-server`.
- **T007** `src/tools.ts`: `createToolHandlers({apiUrl,dashboardToken,jiraEmail,
  jiraApiToken,fetchImpl,maxRetries,retryDelayMs})` — one handler per tool, thin HTTP
  client; `postWithRetry`/`getWithRetry` (4xx no-retry+body, 5xx bounded retry);
  secrets only from config; `structuredContent` on success.
- **T008** `src/main.ts`: `requireEnv` the 4 vars; `TOOL_DEFS` with input+output JSON
  Schema via `z.toJSONSchema(..,{target:'draft-7'})`; ListTools/CallTool wiring.
- **T009** `src/tools.spec.ts`: URL/method/headers per tool; secret-cannot-be-smuggled;
  4xx→error no retry; 5xx→bounded retries; create_workspace injects env creds into body.

## Phase 4 — Integration + wiring

- **T010** `test/integration/admin-mcp.integration.spec.ts`: drive the handlers against
  the real `BackendAppModule` + mock Jira — create_workspace → enabled=false;
  create_team atomic (invalid ⇒ 422, zero created) + happy path; generate_agents
  202/409.
- **T011** Root `package.json`: add `@brigadir/admin-mcp` to `build`, `typecheck`,
  `test` (mirror `@brigadir/mcp-server`).

## Phase 5 — Docs

- **T012** `packages/admin-mcp/README.md` (example Claude Code config, no real secrets).
- **T013** `docs/architecture.md` §5 admin-plane subsection; `docs/plan-internal.md`
  iteration row; `docs/progress.md` checkpoint.

## Phase 6 — Gates

- **T014** `pnpm typecheck && pnpm lint && pnpm test` + `pnpm test:integration` green;
  commit; draft PR.
