# Implementation Plan: Admin MCP server `brigadir-admin`

**Branch**: `012-admin-mcp` | **Date**: 2026-07-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-admin-mcp/spec.md`

## Summary

Ship `packages/admin-mcp` — a stdio MCP server `brigadir-admin` — as a thin HTTP
client of the dashboard admin API. Nine tools (5 read, 4 write) let a human+Claude
outside any run assemble a team: recon the board, create a paused workspace, and
spawn agents. Tool schemas (input AND output) are zod 4, authored in
`packages/contracts` next to the existing ones, converted with
`z.toJSONSchema(..., { target: 'draft-7' })`. The only backend change is a new
atomic endpoint `POST /api/workspaces/:id/team`, built by extracting the
validate+insert core out of `SetupApplyService`'s run-bound accept path so it can
run WITHOUT a run and WITHOUT a review task; the run path's behavior is unchanged.

## Technical Context

**Language/Version**: TypeScript 5.7 (strict), Node ≥22.

**Primary Dependencies**: `@modelcontextprotocol/sdk` ^1.29, `zod` ^4,
`@brigadir/contracts` (workspace). Backend: NestJS 11, drizzle, `@brigadir/pipeline`
(`SetupApplyService`).

**Storage**: none in the package (HTTP client). Backend endpoint uses the existing
Postgres via drizzle.

**Testing**: vitest. Handler units with injectable `fetchImpl` (mirrors
`packages/mcp-server/src/tools.spec.ts`); contract tests for the zod schemas;
integration against the real `BackendAppModule` with mock Jira.

**Target Platform**: Linux/macOS CLI (stdio), plugged into Claude Code.

**Project Type**: monorepo package (cli) + a backend endpoint.

**Constraints**: stdout = MCP protocol only, logs to stderr; secrets only from env;
4xx → tool error (no retry) with body; 5xx/network → bounded retries. Draft-07 wire
dialect pinned (repo convention, iteration 16).

**Scale/Scope**: 9 tools, ~1 new backend route, 1 service refactor.

## Constitution Check

*GATE: passed before design; re-checked after.*

- **I. Dual Source of Truth** — N/A additive. No new source of truth; the server is a
  client of the existing API. The `create_team` endpoint writes only `agents`
  (Postgres, the run-history authority) and never touches ticket status. ✅
- **II. Idempotency at Three Levels** — `generate_agents` goes through the untouched
  feature-011 path (its three layers intact). `create_team` is not a run-triggering
  path (it creates agent rows, like the dashboard agent CRUD, guarded by the DB
  `agents_workspace_name` unique + a `worker_agents_exist` precondition); the
  three-level run dedup does not apply. ✅
- **III. System-Only Jira Writes** — the server performs ZERO Jira writes. Board
  statuses are read via the existing `GET /:id/statuses`. `create_workspace` runs the
  wizard's server-side verify (read-only Jira). ✅
- **IV. Run Completion Contract** — untouched. `create_team` does NOT finalize a run
  (that is exactly what makes it run-independent). The run-bound `team` accept path
  keeps its guarded finalize. ✅
- **V. Secret Isolation & Output Scrubbing** — secrets live ONLY in the server's env,
  never in argv, never in a tool's input schema; the bearer goes in the header and
  the Jira token into the workspace-create body server-side. A "token cannot be
  smuggled through arguments" unit test enforces it. ✅
- **VI. Test-Mandatory Pipeline Logic** — the endpoint reuses `SetupApplyService`'s
  validator/applier (already the tested pipeline path). New tests ship in the same
  change: handler units, schema contract tests, and integration (create_workspace
  paused, create_team atomic, generate_agents 202/409, feature-011 suite still green).
  ✅

**No violations — Complexity Tracking empty.**

## Project Structure

### Documentation (this feature)

```text
specs/012-admin-mcp/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── admin-tools.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/contracts/src/
└── admin-tools.schema.ts        # NEW: input+output zod schemas for all 9 tools
    admin-tools.schema.spec.ts   # NEW: contract tests (toJSONSchema, bounds, reuse)

packages/admin-mcp/              # NEW package (mirrors packages/mcp-server)
├── package.json                 # bin: brigadir-admin
├── tsconfig.json
├── vitest.config.ts
├── README.md                    # example Claude Code mcp config (no real secrets)
└── src/
    ├── main.ts                  # requireEnv, tool defs, ListTools/CallTool handlers
    ├── tools.ts                 # createToolHandlers({fetchImpl,...}) — thin HTTP client
    └── tools.spec.ts            # handler units (injectable fetchImpl)

apps/backend/src/dashboard/
└── workspaces.controller.ts     # + POST /:id/team

libs/pipeline/src/
└── setup-apply.service.ts       # extract validateTeam + insertTeamAgents; new applyTeam()

test/integration/
└── admin-mcp.integration.spec.ts  # NEW: create_workspace paused, create_team atomic, generate_agents

docs/                            # architecture §5 admin plane, plan-internal row, progress checkpoint
```

**Structure Decision**: A new `packages/admin-mcp` sibling of `packages/mcp-server`,
sharing the contracts package as the single typed source. The backend change is
confined to one controller route plus a non-behavioral refactor of one service.

## Complexity Tracking

*No constitution violations — table intentionally empty.*
