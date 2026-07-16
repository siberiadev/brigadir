# Feature Specification: Admin MCP server `brigadir-admin`

**Feature Branch**: `012-admin-mcp`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "admin MCP server `brigadir-admin` — create workspaces and spawn agents from a Claude Code session"

## Overview

A new stdio MCP server (`packages/admin-mcp`, binary `brigadir-admin`) that a
human plugs into Claude Code. Claude studies a Jira board and/or local code and
then **assembles a team**: it creates a workspace and its agents through the
server's tools. The server is a THIN HTTP client of the dashboard admin API
(`apps/backend/src/dashboard`) — zero direct database access, zero new business
logic. It is the manual, human-in-the-loop precursor to the workspace-orchestrator
planning mode (plan-internal, "админский MCP «Claude-тимлид»").

**Line vs the callback MCP (feature 004/011, `packages/mcp-server`)**: that server
is for an agent INSIDE a run, authenticated with a short-lived per-run JWT and
scoped to callback tools (report/human/complete) + read-only Jira. THIS server is
the admin plane for a human+Claude OUTSIDE any run, authenticated with the
dashboard bearer, and it CREATES workspaces and agents. The two never overlap.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Recon a board and assemble a team (Priority: P1)

The user opens Claude Code with `brigadir-admin` configured, points Claude at a
Jira board, and says "assemble a team for this board." Claude inspects the board
(statuses, existing workspaces/executors), creates a paused workspace, then spawns
the worker agents atomically — each agent's trigger/success/failure statuses taken
from the real board and its executor referenced by profile name.

**Why this priority**: This is the whole feature — the end-to-end path from an
empty board to a ready-but-paused workspace with a team, driven by Claude through
the admin API without the human hand-editing the dashboard.

**Independent Test**: With the backend running, configure the server against it,
call `create_workspace` then `create_team`, and observe a paused workspace with N
enabled worker agents — all through the tools, no dashboard UI.

**Acceptance Scenarios**:

1. **Given** a valid board and Jira bot creds in the server env, **When** Claude
   calls `create_workspace`, **Then** a workspace is created and the result
   reports `enabled: false` (feature 011: workspaces are created PAUSED).
2. **Given** a paused workspace with no worker agents, **When** Claude calls
   `create_team` with a valid roster, **Then** all agents are created enabled in
   one transaction and the tool returns the created count.
3. **Given** a `create_team` roster with one invalid agent (unknown status), **When**
   the tool runs, **Then** the backend returns 422 with path-qualified issues, ZERO
   agents are created, and the tool surfaces the issue list as an error the model
   can repair from.

### User Story 2 - Read-only recon (Priority: P1)

Before writing anything, Claude enumerates existing workspaces, one workspace's
details, its board statuses, the platform executor profiles, and an existing
roster — so its proposal references real status names and real profile names.

**Why this priority**: A team proposal that names a status or profile that does
not exist is rejected; recon tools are what let the model get it right the first
time. They carry no write risk.

**Independent Test**: Call each read tool against a seeded backend and assert the
shapes; `get_board_statuses` returns the live board's status names.

**Acceptance Scenarios**:

1. **Given** a workspace, **When** Claude calls `get_board_statuses`, **Then** it
   receives the board's status names and categories (the only sanctioned source of
   status names for a team proposal).
2. **Given** platform executors, **When** Claude calls `list_executors`, **Then**
   it receives each profile's name/type/model/enabled (agents reference a profile
   by NAME).

### User Story 3 - Let the orchestrator generate the team (Priority: P2)

Instead of hand-authoring the roster, Claude asks the built-in orchestrator to
generate it: `generate_agents` starts the feature-011 setup run and returns its
run id; the human then reviews and starts the workspace in the UI.

**Why this priority**: An alternative to `create_team` that reuses the orchestrator
path; secondary because `create_team` already covers the MVP.

**Independent Test**: Call `generate_agents` on an orchestrator-only paused
workspace → 202 + run_id; call it again → 409 `setup_run_active`/`worker_agents_exist`.

**Acceptance Scenarios**:

1. **Given** a paused workspace whose only agent is the orchestrator, **When**
   Claude calls `generate_agents`, **Then** a setup run starts and its id is
   returned.
2. **Given** a workspace that already has worker agents, **When** Claude calls
   `generate_agents`, **Then** the tool errors with the `worker_agents_exist` code.

### Edge Cases

- A secret (Jira token, bearer) supplied as a TOOL ARGUMENT is ignored — the server
  only ever reads secrets from its own env; the model cannot smuggle or override
  them.
- A backend 4xx surfaces to the model as a tool error WITH the response body so the
  model sees the path-qualified issues and repairs its input; the call is NOT
  retried.
- A backend 5xx / network error is retried with bounded backoff, then surfaces as a
  tool error.
- `create_team` on a workspace that already has worker agents → 409
  `worker_agents_exist` (v1 does not rebuild existing teams).
- stdout carries MCP protocol only; all diagnostics go to stderr.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server MUST be a stdio MCP server named `brigadir-admin`, a THIN
  HTTP client of the dashboard admin API with NO direct database access.
- **FR-002**: The server MUST read its configuration ONLY from env — `BRIGADIR_API_URL`,
  `BRIGADIR_DASHBOARD_TOKEN`, `BRIGADIR_JIRA_EMAIL`, `BRIGADIR_JIRA_API_TOKEN` — via a
  fail-fast `requireEnv` (missing → exit 1 with a stderr message).
- **FR-003**: Secrets MUST NEVER be tool arguments. The dashboard bearer goes only
  into the `Authorization` header; the Jira email/token are injected by the server
  into the `POST /api/workspaces` body. No secret appears in argv or in any tool's
  input schema.
- **FR-004**: Every tool MUST declare BOTH an `inputSchema` and an `outputSchema`
  (MCP structured output). Schemas are zod 4, live in `packages/contracts`, and are
  converted to JSON Schema with `z.toJSONSchema(schema, { target: 'draft-7' })`.
  Every field carries `.describe(...)` with bounds/examples and a note on what the
  server validates. All objects are `.strict()`.
- **FR-005**: `create_team` MUST reuse `TeamAgentSchema` from `packages/contracts`
  (no copy).
- **FR-006**: Read-only recon tools: `list_workspaces`, `get_workspace`,
  `get_board_statuses`, `list_executors`, `list_agents`. `list_workspaces` MUST
  flatten pagination server-side (page_size=100).
- **FR-007**: `create_workspace` MUST create a workspace through `POST /api/workspaces`;
  the result's `enabled` MUST always be `false` (feature-011 paused-on-create). The
  server MUST NOT expose a "start workspace" tool — Start stays with the human.
- **FR-008**: `generate_agents` MUST call `POST /api/workspaces/:id/generate-agents`
  and surface the 409 codes (`worker_agents_exist`, `no_orchestrator`,
  `setup_run_active`).
- **FR-009**: `create_team` MUST call a new backend endpoint `POST /api/workspaces/:id/team`
  (DashboardTokenGuard) that validates and applies the roster atomically — an invalid
  agent mid-list ⇒ 422 and ZERO created. It reuses the validator and applier from
  `SetupApplyService`, invoked WITHOUT a run and WITHOUT a review task. Precondition:
  the workspace has no worker agents (409 `worker_agents_exist`).
- **FR-010**: `create_agent` / `update_agent` MUST be pointwise wrappers over
  `POST /api/agents` and `PUT /api/agents/:id`, going through the same server-side
  `lintAgent` validation. NO deletion tool (the orchestrator is server-protected).
- **FR-011**: A backend 4xx MUST surface to the model as a tool error WITH the
  response body and MUST NOT be retried. A 5xx / network error MUST be retried with
  bounded backoff, then surfaced.
- **FR-012**: The run-bound `team` accept path (feature 011) MUST NOT change behavior;
  the existing feature-011 integration tests MUST stay green.
- **FR-013**: No Jira writes from anywhere in this feature (Constitution Principle III).

### Key Entities

- **Admin tool**: name + input zod schema + output zod schema + a handler that maps
  to one dashboard HTTP call. Lives in `packages/admin-mcp`; schemas in `packages/contracts`.
- **Team proposal**: `{ workspace_id, agents: TeamAgent[1..20] }`; `TeamAgent` reused
  from `report.schema`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A `create_workspace` result always reports `enabled: false` (asserted
  in an integration test against the real backend).
- **SC-002**: A `create_team` with one invalid agent creates ZERO agents and returns
  422 with path-qualified issues (asserted in integration).
- **SC-003**: A secret passed as a tool argument never reaches the wire — the handler
  sends only env-derived credentials (asserted in a unit test).
- **SC-004**: `z.toJSONSchema(schema, { target: 'draft-7' })` on every tool's input
  and output schema does not throw and carries descriptions/bounds (contract test).
- **SC-005**: The existing feature-011 setup-run suite passes unchanged.

## Assumptions

- The backend dashboard API is reachable at `BRIGADIR_API_URL` and its bearer is
  valid; the server does no token management of its own.
- The Jira bot credentials in the server env are the workspace's credentials for
  `create_workspace` (the same pair the wizard would submit).
- Team regeneration when worker agents already exist is out of scope (matches
  feature 011); so are start/pause and any deletion.
- The MCP client is Claude Code; the example config in the package README targets it.
