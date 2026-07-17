<div align="center">

```
██╗           ██████╗ ██████╗ ██╗ ██████╗  █████╗ ██████╗ ██╗██████╗
╚██╗          ██╔══██╗██╔══██╗██║██╔════╝ ██╔══██╗██╔══██╗██║██╔══██╗
 ╚██╗         ██████╔╝██████╔╝██║██║  ███╗███████║██║  ██║██║██████╔╝
 ██╔╝         ██╔══██╗██╔══██╗██║██║   ██║██╔══██║██║  ██║██║██╔══██╗
██╔╝ █████╗   ██████╔╝██║  ██║██║╚██████╔╝██║  ██║██████╔╝██║██║  ██║
╚═╝  ╚════╝   ╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝
```

**An orchestrator for a brigade of AI coding agents, on top of Jira.**

*The board is the only dashboard. Status is the only protocol. The foreman hands out the work.*

<br/>

![Node](https://img.shields.io/badge/Node-22_LTS-3C873A?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square)
![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square)
![Vue](https://img.shields.io/badge/Vue-3-42B883?style=flat-square)
![Postgres](https://img.shields.io/badge/Postgres-16-336791?style=flat-square)
![Redis](https://img.shields.io/badge/Redis_+_BullMQ-5-DC382D?style=flat-square)
![License](https://img.shields.io/badge/mode-internal_tool-6E56CF?style=flat-square)

</div>

---

## What it is

BRIGADIR turns a **Jira board into a control panel for a team of AI agents**. You don't write the pipeline explicitly — you attach an agent to each column of the board. A ticket enters a status → the foreman spins up the matching agent (`claude -p` in an isolated git worktree) → the agent does the work and reports a structured result → the foreman moves the ticket down the board. The next status triggers the next agent.

**The pipeline is emergent** — it arises from the board's statuses, not from a config file. A human can step in at any moment right inside Jira, and that's part of the protocol, not a failure mode.

```
        ┌──────────────────────────┐
        │          JIRA            │   source of truth for ticket status
        │   ● Ready for Dev        │
        └────────────┬─────────────┘
                     │  status changed (webhooks + reconciliation polling)
        ┌────────────▼─────────────┐
        │        BRIGADIR          │   the foreman: matches an agent, hands out
        │  match · dedup · enqueue │   the work, drives statuses, writes comments
        └────────────┬─────────────┘
         ┌───────────┼───────────┐
         ▼           ▼           ▼
     ┌───────┐   ┌───────┐   ┌───────┐
     │ agent │   │ agent │   │ agent │   the brigade: claude -p in a git worktree,
     │  QA   │   │  Dev  │   │Planner│   MCP tools for structured reports
     └───┬───┘   └───┬───┘   └───┬───┘
         └───────────┴───────────┘
                     │  report_progress · request_human · complete_task
                     ▼
              status ← down the board  →  next agent in the chain
```

## Why

The project grew out of the pain of running an agent pipeline on **Jira Automation**. Three things it fixes:

| Pain | Before | After |
|---|---|---|
| **Unreliable engine** | Jira Automation silently drops triggers, double-fires, doesn't survive downtime | Dedup at three levels, a high-water-mark poller catches up on anything missed, idempotent runs |
| **Walls of logs** | The ticket comment is a hundred lines of raw agent log | A readable ✅/❌ checklist in Jira + a run card with a timeline, cost, and usage |
| **"The agent is stuck"** | No idea where an agent is waiting on a human, or whether it is | A single **human queue**: `request_human` → a task in the queue in ≤ 5s → answering from the UI resumes the run |

The model is bigger than a single pipeline: **workspace + agents + scope_jql = a temporary team of digital employees** scoped to a narrow list of tasks. Assemble a brigade for a sprint feature, switch it on, disband it — the history stays.

## Principles (never broken)

1. **Only the system writes to Jira.** An agent never moves the card or comments itself — it reports through tools (`report_progress` / `request_human` / `complete_task`), and the foreman does the transitions, comments, and human tasks. The rule is baked into the instruction wrapper.
2. **Jira is the source of truth for status.** The orchestrator never assumes a ticket is in a status it hasn't seen in Jira; the local `last_seen_status` is a cache for diffing, not truth.
3. **Runs are idempotent.** Webhook-event dedup → BullMQ `deduplication` → a partial unique index on the active run per `(ticket, agent)`. No layer is ever removed.
4. **A run completes when `complete_task` arrives.** Any other process exit without it is `failed` with diagnostics. A Stop-hook forces a Claude agent to call the tool.
5. **Agents never launch each other.** The chain runs only through Jira statuses. The pipeline stays compatible with manual intervention.

## How it works

```
                        ┌─────────────────────────────────────────────┐
                        │                 Jira Cloud                  │
                        └───────┬─────────────────────▲───────────────┘
             webhooks /         │                     │  transitions · ADF comments
             JQL polling        │                     │  (per-issue write queue, 20/2s)
                        ┌───────▼─────────────────────┴───────────────┐
   Vue Dashboard ◄─SSE──┤                NestJS Backend               │
   (runs, checklists,   │  Jira · Ingest · Pipeline · Run · Callback  │
    human queue)──REST─►│  HumanTask · Executor                       │
                        └───────┬───────────────────▲─────────────────┘
                                │ enqueue           │ MCP / HTTP callback
                        ┌───────▼───────┐           │  (report / request_human /
                        │ Redis + BullMQ│           │   complete_task, run JWT)
                        │ queue / type  │           │
                        └───────┬───────┘           │
                        ┌───────▼───────────────────┴─────────────────┐
                        │             Worker (NestJS WorkerHost)      │
                        │   git worktree · env sanitizer · secret     │
                        │   scrubber · claude -p + brigadir MCP tools │
                        └─────────────────────────────────────────────┘
```

The **control plane (backend)** and **execution plane (worker)** are two processes sharing only Postgres + Redis. Restarting the backend doesn't drop in-flight runs.

- **Postgres 16** — source of truth for history: runs, checklists, events, human tasks, usage/cost.
- **Redis + BullMQ 5** — queues only: per-executor concurrency, dedup, reconciliation scheduler.
- **Jira** — source of truth for ticket status.

### Stack

`pnpm` monorepo · NestJS 11 (backend + worker) · Vue 3 + Vite + Pinia + TanStack Query + Element Plus (web) · Drizzle ORM with committed migrations · zod contracts (framework-free) · a Streamable-HTTP MCP server for the callback tools · vitest + Testcontainers (real Postgres/Redis, no broker mocks).

---

## Quick start

**Requirements:** Node.js 22+ (see `.nvmrc`; `--env-file` needs it), pnpm (`corepack enable` turns it on), Docker with a running daemon (needed both for `docker compose` and for the integration tests via Testcontainers). For live agent runs — an installed and logged-in `claude` CLI.

### 1. Install & static checks

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace, strict mode
pnpm lint
```

### 2. Tests

```bash
pnpm test                        # unit: contracts + mcp-server + libs
pnpm test:integration            # Testcontainers: Postgres 16 + Redis 7, migrations from scratch — needs Docker
pnpm --filter @brigadir/web test # dashboard component tests
```

Integration tests boot real containers, apply the committed migrations, and exercise the run scenarios, dedup, rate-limit accounting, the status machine, and reconcile — deterministically (re-running yields identical results).

### 3. Run for development (dev mode)

The happy path from a clean clone to a working dashboard. Full detail — the `agents.yaml` story, first steps in the UI, a gotchas table — lives in [`docs/local-setup.md`](docs/local-setup.md); how the pieces fit together — in [`docs/architecture.md`](docs/architecture.md).

**Secrets.** Copy the template and generate the three required values (boot **fails fast** without any of them — that's by design, don't work around it with defaults):

```bash
cp .env.example .env
openssl rand -base64 32   # → BRIGADIR_CREDENTIALS_KEY  (AES-256-GCM key for Jira creds at rest)
openssl rand -hex 32      # → BRIGADIR_DASHBOARD_TOKEN  (dashboard bearer — you'll paste it into the UI)
openssl rand -hex 32      # → BRIGADIR_JWT_SECRET       (signs per-run callback tokens)
```

**Infrastructure** — only Postgres and Redis in containers:

```bash
docker compose up -d postgres redis
```

The ports are non-standard **on purpose**: Postgres on **5434**, Redis on **6380**, so a brew-installed Postgres/Redis squatting on 5432/6379 can never intercept the connection (the classic `role "brigadir" does not exist` — see the gotchas table in [`docs/local-setup.md`](docs/local-setup.md)). `DATABASE_URL`/`REDIS_URL` in `.env.example` already point at them.

**Backend + worker**, the simple way — build once, run from `dist/`:

```bash
pnpm install && pnpm build
node --env-file=.env dist/apps/backend/main.api.js     # terminal 1: applies migrations + seed on boot
node --env-file=.env dist/apps/worker/main.worker.js   # terminal 2: poller, reconcile, run execution
```

> ⚠️ `node --env-file` is mandatory — nothing reads `.env` by itself.

Check: `curl localhost:3000/health` → `{ "status": "ok", "db": "up", "redis": "up" }`.

**Frontend** — two options:

```bash
pnpm --filter @brigadir/web dev   # Vite + hot-reload → http://localhost:5173, /api proxied to :3000
```

…or skip Vite and open http://localhost:3000 — the backend serves the built SPA itself (already produced by `pnpm build`).

**First login:** the dashboard asks for a bearer — paste `BRIGADIR_DASHBOARD_TOKEN` from your `.env`.

**Hot mode (watch)** — instead of the two `node` processes:

```bash
set -a; source .env; set +a            # nest start doesn't read .env either
pnpm exec nest start backend --watch
pnpm exec nest start worker --watch
```

What watch actually picks up — nest-webpack bundles only `apps/*` and `libs/*` from source; `packages/*` are runtime externals resolved from `packages/*/dist`:

| You edit… | Watch picks it up? |
|---|---|
| `apps/*`, `libs/*` | ✅ yes — bundled from source |
| `packages/*` (`@brigadir/contracts`, `mcp-server`, …) | ❌ only after `pnpm --filter <pkg> build` |

So: before the first watch run, do `pnpm --filter @brigadir/contracts build` and `pnpm build:mcp-server` (the worker needs mcp-server for the callback channel). After editing `packages/contracts` — rebuild it (or keep `pnpm --filter @brigadir/contracts exec tsc -w` running as a third process), otherwise boot dies with `Cannot read properties of undefined` on new exports while typecheck stays green.

> ⚠️ A watch-triggered worker restart kills active runs.

### 4. Run in production (docker compose)

The currently supported production path is the full compose stack. `docker-compose.yml` carries no secret values — add the three `BRIGADIR_*` vars as a pass-through list to the `backend` and `worker` services (names only, no values — see §3 of [`docs/local-setup.md`](docs/local-setup.md)), then:

```bash
export BRIGADIR_CREDENTIALS_KEY=... BRIGADIR_DASHBOARD_TOKEN=... BRIGADIR_JWT_SECRET=...
docker compose up --build
# → http://localhost:3000
```

From empty volumes: Postgres and Redis become healthy → **backend** applies migrations and seeds workspace/executors/agents from `agents.yaml` (if present), then serves `GET http://localhost:3000/health` → `{ "status": "ok", "db": "up", "redis": "up" }` → **worker** connects and registers the consumers + reconcile scheduler.

**Known limitations of the current compose** (hardening is a separate iteration):

- Postgres has **no named volume** — data lives inside the container and dies with it.
- No `restart:` policy on any service.
- Ports **5434/6380 must never be published externally** — they exist for local convenience only.
- Put a **reverse proxy with TLS** in front of port 3000.
- Live agent runs inside the container need git/ssh/`claude` CLI in the image and **API-key executor profiles** — claude subscription auth is only legal on the user's own machine ([`docs/architecture.md`](docs/architecture.md) §4).

### 5. Assemble a team from Claude Code (`brigadir-admin` admin-MCP)

`packages/admin-mcp` is a stdio MCP server you plug into **Claude Code** to build a team _outside_ any run: recon a board → `create_workspace` (always PAUSED) → `generate_agents` / `create_team` / `create_agent`. It is a thin HTTP client of the dashboard admin API, so the backend must be up. (Not to be confused with `mcp-server` / `brigadir-mcp`, the callback channel used _inside_ a run.)

The repo ships a project-scoped [`.mcp.json`](.mcp.json) — Claude Code loads it automatically on start. One-time setup:

```bash
pnpm --filter @brigadir/admin-mcp build      # dist/ is gitignored — build after clone
# add BRIGADIR_JIRA_EMAIL / BRIGADIR_JIRA_API_TOKEN to .env (see .env.example)
set -a; source .env; set +a                  # export vars so ${VAR} in .mcp.json resolves
claude                                        # restart Claude Code → /mcp shows brigadir-admin
```

Env consumed by the server (only from env — Constitution V): `BRIGADIR_API_URL` (default `http://localhost:3000`), `BRIGADIR_DASHBOARD_TOKEN`, `BRIGADIR_JIRA_EMAIL`, `BRIGADIR_JIRA_API_TOKEN`. MCP servers are read at session start — a restart is required after first setup.

---

## Repository layout

```
apps/
  backend    HTTP control plane: migrations → seed → /health → REST + SSE
  worker     BullMQ consumers: RunProcessor + reconcile scheduler
  web        Vue 3 dashboard (workspaces · agents · runs · human queue · settings)
  smoke      one-shot trigger helper
libs/
  jira       v3 client, rate-limiter, per-issue write queue, transition discovery, ADF
  ingest     webhook endpoint + reconciliation poller (high-water mark)
  pipeline   ticket state machine, agent matching, dedup
  runs       run lifecycle, events, checklists, status mapping
  callback   HTTP callback API + MCP channel, run JWT
  human-tasks the "needs a human" queue, run resume
  executors  AgentExecutor contract, registry, claude_cli / mock
  database   Drizzle schema + migrator
  queues     queue registry, backoff, connection
  app-config fail-fast agents.yaml loader + yaml→DB seeder
  scrubber   secret scrubber for the agent's output stream
packages/
  contracts  zod schemas (Report, AgentsConfig, TriggerEvent, callbacks, pagination)
  mcp-server stdio/streamable MCP: report_progress · request_human · complete_task
  admin-mcp  stdio MCP for Claude Code: create workspaces + agents (dashboard bearer)
drizzle/     committed migrations (reviewed against architecture.md §3)
```

## Docs — the source of truth

The design docs are maintained in Russian.

| File | What's inside |
|---|---|
| [`docs/plan-internal.md`](docs/plan-internal.md) | **The live working plan** — iterations, decisions made (wins on conflicts) |
| [`docs/spec.md`](docs/spec.md) | Detailed spec: endpoints, tables, module behavior |
| [`docs/architecture.md`](docs/architecture.md) | DB schema (§3), the AgentExecutor contract (§4), callback protocol (§5), ReportSchema (§6) |
| [`docs/progress.md`](docs/progress.md) | Iteration journal |
| [`docs/local-setup.md`](docs/local-setup.md) | Local setup |
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Mandatory principles, enforced by spec-kit gates |

---

<div align="center">
<sub>Internal team tool · non-commercial mode · Jira via API token, execution on your own infra</sub>
</div>
