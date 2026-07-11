# Research: Callback Channel & Reports

All mechanics verified against the operator's installed CLI **v2.1.207** (`claude --version`), with
live prototypes run 2026-07-11 for the two security-critical unknowns (D1, D2). "Prototype-level
certainty" markers below cite the exact probe.

---

## D1 — Token handoff to the MCP server without exposing it to the agent (SECURITY CORE)

**Decision:** Write the per-run JWT as a **literal string value** inside the mcp-config server `env`
block, in a per-run `0600` file. Do **NOT** use `${VAR}` interpolation.

**Prototype (v2.1.207, 2026-07-11):**

- *Probe A — does the Bash tool inherit `claude`'s own process env?* Set
  `BRIGADIR_PROBE_TOKEN=…` in the shell that launched `claude -p`, then asked the agent to
  `printenv | grep BRIGADIR_PROBE_TOKEN`. **Result: the token WAS present in the Bash environment
  (leaked).** → Any value in `claude`'s process env is visible to the agent via the Bash tool.
- *Probe B — where does a literal mcp-config `env` value land?* mcp-config with
  `env: { BRIGADIR_RUN_TOKEN: "LITERAL_secret_xyz789", MCP_ENV_DUMP: "<path>" }`, a fake MCP server
  that dumps `process.env` at spawn. `BRIGADIR_RUN_TOKEN` was unset in the launching shell.
  **Result: the literal appeared in the MCP child's env dump; the agent's Bash reported `IS_UNSET`.**
  → A literal `env` value reaches **only** the spawned MCP server process, never `claude`'s own env,
  never the agent's Bash.

**Rationale:** `${BRIGADIR_RUN_TOKEN}` interpolation requires the token to live in `claude`'s
process env for expansion — which Probe A proves the agent can read (`printenv`). That is exactly the
FR-004/FR-005 leak. The literal-in-file path (Probe B) keeps the token structurally unreachable to
the agent: not in argv (`ps` shows only the `--mcp-config <path>` flag, not the token), not in the
agent's env.

**Residual exposure & mitigation (accepted for architecture §8 Phase 0–1):** the token is a literal
on disk. `ps` reveals the mcp-config path; a same-uid Bash could `cat` it. Mitigations: file mode
`0600`, written **outside** the worktree (not in cwd / `--add-dir`, so file tools don't surface it),
deleted at run cleanup. Blast radius is bounded by design even if read — the token is single-run
(`sub == runId`), short-TTL, callback-only, and the guard **re-checks run state in the DB on every
call** (FR-003), so a leaked token only lets the agent do what it is already meant to do (call its
own callbacks) and dies with the run. The true secret-broker (token never on the host the agent can
reach) is architecture §8 Phase 2 — deferred, not regressed.

**Constitution impact:** contradicts the **letter** of Principle V ("Config files reference them via
env interpolation … never inline values") while serving its **spirit**. Flagged in the plan's
Constitution Check + Complexity Tracking; a constitution PATCH is recommended to correct the example.

**Alternatives considered:**
- `${VAR}` interpolation — rejected: proven leak (Probe A).
- Inline JSON string to `--mcp-config` (no file) — rejected: puts the token in `claude`'s argv,
  visible via `ps` to the agent's Bash — strictly worse.
- OS keyring / broker fetch by the MCP server — deferred to Phase 2 (architecture §8); over-scoped
  for a single-host internal tool.

---

## D2 — Stop hook in print mode (session enforcement, FR-022/FR-023)

**Decision:** Register a `Stop` hook via `--settings` (inline JSON). The hook reads its stdin JSON,
allows session end iff the **completion marker file** exists; otherwise emits
`{"decision":"block","reason":"You must call mcp__brigadir__complete_task (or request_human) before
finishing."}`. The hook MUST allow when `stop_hook_active === true` (the bound).

**Prototype (v2.1.207, 2026-07-11):** `--settings '{"hooks":{"Stop":[{"hooks":[{"type":"command",
"command":"node stop-hook.mjs"}]}]}}'` on a `claude -p …` run. The hook appended each invocation to a
log. **Result:**
```
fired stop_hook_active=false     ← first end attempt → we blocked
fired stop_hook_active=true      ← re-entry after block → we allowed
```
→ **Stop hooks DO fire in `-p` print mode**, and `stop_hook_active` flips `false → true` across the
block. This confirms both that enforcement is available and that `stop_hook_active` is the
boundedness mechanism (FR-023): block once while the marker is absent, then honor the flag so a stuck
agent still terminates and is caught by FR-010 fail-closed.

**Rationale:** The Stop hook is best-effort UX to nudge a well-behaved agent to call `complete_task`.
It is **not** the guarantee — FR-010 (process ended `running` ⇒ `failed`) is. So even if a future CLI
changed hook semantics, correctness holds. Marker path is baked into the hook `command` string in the
settings JSON (a path is not a secret).

**Alternatives considered:** exit-code-2 blocking (stderr) — equivalent, but the JSON `decision`
form carries a `reason` string back to the model, better for the agent's repair loop. `--settings`
file vs inline JSON — inline string keeps it per-run and out of any shared file; both work in print
mode.

---

## D3 — MCP tool naming, allowlisting, and the repair loop (FR-006/FR-008)

**Decision:** Name the server `brigadir` in the mcp-config. The agent sees exactly:
`mcp__brigadir__report_progress`, `mcp__brigadir__request_human`, `mcp__brigadir__complete_task`.
All three MUST be added to `--allowed-tools` alongside `--strict-mcp-config`. Tool-call errors
(schema validation, transient HTTP) are returned by the MCP handler as an MCP tool error result;
`claude` surfaces it to the model as a failed `tool_result`, enabling the FR-006/FR-008 repair loop
(the model reads the machine-readable error and resubmits).

**Rationale:** Tool naming `mcp__<server>__<tool>` is the fixed MCP convention; `--strict-mcp-config`
guarantees only our server's tools exist (no host MCP leakage, Constitution V). The `--allowed-tools`
list already exists in `buildArgs` (iteration 3) — we append the three `mcp__brigadir__*` names when
`useCallbackChannel` is on. Validation errors from `CompleteTaskSchema`/`ReportSchema` are returned
as a structured error payload (zod `error.issues`) so the agent can repair without guessing
(FR-008 machine-readable list).

**Note:** `report_progress` / `request_human` should be **non-blocking-permission** (auto-allowed via
`--allowed-tools` + `--permission-mode` already used). No user prompt can occur in `-p`.

---

## D4 — Run JWT (authentication factor, not authorization source of truth)

**Decision:** HS256 with **node built-in `crypto`** (`createHmac('sha256', …)`), **no new
dependency**. Signer lives in `packages/contracts/src/run-token.ts` exporting `signRunToken(claims,
secret)` and `verifyRunToken(token, secret)` + the `RunTokenClaims` type (single typed source,
Constitution "Technology Constraints"). Claims:
```jsonc
{ "sub": runId, "wsp": workspaceId, "tkt": ticketKey,
  "iat": <epoch s>, "exp": <started_at + timeout_ms + grace> }   // grace = 5 min
```
The worker mints the token when building `RunContext.callback.runToken`; the backend `run-token.guard`
verifies signature + `exp` + `sub == :runId` path param, **then re-reads the run row** and requires
`status ∈ {running, awaiting_human}` (FR-003). Secret from env `BRIGADIR_JWT_SECRET`, shared by
worker (sign) and backend (verify), resolved in a **DI factory** — never at `@Module()` composition
(Constitution "Lazy resource resolution").

**Rationale:** The token is an *authentication* factor; the DB status check is the *authorization*
source of truth, so a stale/leaked token cannot resurrect a closed run (spec edge cases; SC-004,
SC-007). HS256 is symmetric and both apps are first-party on one host — no need for RS256/JWKS.
Hand-rolling HS256 over `crypto` is ~20 lines and avoids `jsonwebtoken`/`jose`.

**Alternatives considered:** `jsonwebtoken` — rejected (unnecessary dep; user constraint prefers no
new runtime deps). Opaque random token + DB lookup table — rejected: adds a table and a write on
every mint; the signed claims carry `wsp`/`tkt` for cheap context without a round-trip, and the DB
status re-check already provides revocation.

---

## D5 — Wrapper feature context (FR-026): sourcing + hard size budget

**Decision:** The instruction wrapper gains a **Feature context** section compiled from two sources:

1. **Jira (bounded, statuses only):** via a new bounded `JiraClient` read — the ticket's **epic**
   and its **linked issues** with `{ key, status, summary }`. No descriptions, no comments.
2. **Our DB:** for each linked issue that has a prior run whose `runs.report.artifacts` declared a
   `branch` / `pr_url`, extract those. Read-only over `runs` joined to `tickets` by `jira_key`.

**Hard size budget & truncation:**
- Max **20** linked issues; overflow rendered as `…and N more`.
- Each issue → one line: `KEY [status] summary(≤80 chars, ellipsized)`.
- Branch/PR lines only for issues that have them; each URL/branch ≤ 200 chars.
- Total Feature-context section capped at **~2 KB**; if exceeded, drop prior-run artifacts first,
  then truncate the issue list.

**Rationale:** A large epic must not blow the agent's context or cost. Statuses+keys+one-line
summaries give downstream agents continuity ("what upstream produced, where the branch is") without
importing whole ticket bodies. Sourcing branches/PRs from our own report DB (not re-scraping Jira)
keeps it cheap and authoritative (the report is the system's record).

**Alternatives considered:** full linked-issue descriptions — rejected (context blowup). Live Jira
scrape for branches — rejected (our report DB already holds them, per architecture §6 artifacts).

---

## D6 — `--json-schema` retirement & explicit channel selection (FR-011)

**Decision:** Add an explicit `useCallbackChannel: boolean` to the `claude_cli` `executors.config`
(resolved in `claude-cli.config.ts`). When **true**: `buildArgs` omits `--json-schema`, and the
executor writes the mcp-config + Stop-hook settings. When **false** (or absent): the iteration-3
behavior is unchanged (`--json-schema` + `structured_output` extraction). The **mock** executor and
its in-process report path are untouched.

**Rationale:** The spec forbids implicit magic ("make the channel selection explicit config"). A
single boolean makes the retirement auditable and keeps feature-003 lifecycle tests (which rely on
`structured_output`) valid by simply not setting the flag. Exactly one completion channel is live per
run (FR-011): callback-wired runs have no `--json-schema`, so `terminal.structuredOutput` is never a
finalize source; any final text is diagnostics only.

---

## D7 — Fail-closed interaction with `awaiting_human` (FR-010 vs FR-012)

**Decision:** For callback-wired runs the processor's no-report exit path calls a new
`RunsService.failIfStillRunning(runId, diagnostic)` that guards **`WHERE status = 'running'`** only
(not the full active set). If `complete_task` already finalized the run (`succeeded`/`failed`) or a
blocking `request_human` parked it (`awaiting_human`), the guarded UPDATE matches **0 rows** — a
no-op — so fail-closed never clobbers a legitimately parked or completed run.

**Rationale:** The existing `finalizeStatus` guards `status ∈ {queued,running,awaiting_human}` — using
it for fail-closed would wrongly flip an `awaiting_human` run to `failed`. The blocking-escalation
exit (FR-012/FR-013) is a *legitimate* process end; only a genuinely `running` run at process exit is
the FR-010 silent failure. This is the one behavioral seam where FR-010 and FR-012 meet.

---

## D8 — Completion marker mechanics (FR-013)

**Decision:** The marker is a **file on disk** whose absolute path is passed to (a) the MCP server via
its `env` block (`BRIGADIR_MARKER_PATH`) and (b) the Stop hook via its `command` string. The MCP
server writes the marker **after** a successful `complete_task` or blocking `request_human` HTTP
response (2xx). The Stop hook reads the file's existence.

**Rationale:** Matches architecture §5 ("маркер-файл, который пишет MCP-сервер"). Keeps the MCP
server DB-free — it only needs a local FS write. Server-side truth (run status) still governs
correctness; the marker is purely the local handshake that lets the agent's session end cleanly.
Placed alongside the mcp-config (outside the worktree), cleaned up with the run.

---

## D9 — Callback delivery resilience (FR-006)

**Decision:** The MCP server `POST`s with **bounded retries** (e.g. 3 attempts, short backoff) on
transient/network failures and 5xx; on a 4xx validation error it does **not** retry but returns the
error body to the model (repair loop, D3). A single blip does not drop a report (SC-006 timeline
integrity). The backend callback handlers are safe to retry: `progress` appends a `run_events` row
(idempotency not required — duplicate progress is harmless); `complete` is idempotent (409 on the
already-finalized run).

**Rationale:** "Callback must not be lost to a single blip" (spec edge case) with an at-least-once
client and an idempotent-completion server is the simplest correct combination. `complete`'s 409 and
the guarded terminal UPDATE make a retried completion safe.

---

## Summary of decisions

| ID | Decision |
|---|---|
| D1 | Literal run token in a `0600` mcp-config `env` block (NOT `${VAR}`); proven not to leak to agent Bash on v2.1.207. |
| D2 | Stop hook via `--settings`; fires in print mode; `stop_hook_active` bounds it to one block. |
| D3 | Tools `mcp__brigadir__{report_progress,request_human,complete_task}`; add to `--allowed-tools` + `--strict-mcp-config`; errors → tool_result for repair loop. |
| D4 | HS256 run JWT via node `crypto` (no dep); claims `{sub,wsp,tkt,iat,exp}`; guard = signature + `sub`==path + DB status re-check. |
| D5 | Feature context: epic + linked-issue statuses (Jira, bounded) + prior branches/PRs (our report DB); ≤20 issues, ~2 KB cap. |
| D6 | Explicit `useCallbackChannel` config drops `--json-schema`; mock + non-callback runs unchanged. |
| D7 | Fail-closed guards `WHERE status='running'` only — never clobbers `awaiting_human`/finalized. |
| D8 | Completion marker = local file; MCP server writes on success; Stop hook reads it. |
| D9 | MCP client bounded retries on transient failures; server completion idempotent (409). |
