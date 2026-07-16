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

**Requirements:** Node.js 22 LTS (see `.nvmrc`), pnpm ≥ 9, Docker with a running daemon (needed both for `docker compose` and for the integration tests via Testcontainers).

### 1. Install & static checks

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace, strict mode
pnpm lint
```

### 2. Tests

```bash
pnpm test              # unit: contracts + mcp-server + libs
pnpm test:integration  # Testcontainers: Postgres 16 + Redis 7, migrations from scratch
```

Integration tests boot real containers, apply the committed migrations, and exercise the run scenarios, dedup, rate-limit accounting, the status machine, and reconcile — deterministically (re-running yields identical results).

### 3. Full stack, one command

```bash
cp .env.example .env      # optional for local, informational
docker compose up --build
```

From empty volumes: Postgres and Redis become healthy → **backend** applies migrations and seeds workspace/executors/agents from `agents.yaml`, then serves `GET http://localhost:3000/health` → `{ "status": "ok", "db": "up", "redis": "up" }` → **worker** connects and registers the consumers + reconcile scheduler.

> Local dev mode, secrets, and gotchas live in [`docs/local-setup.md`](docs/local-setup.md).

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
