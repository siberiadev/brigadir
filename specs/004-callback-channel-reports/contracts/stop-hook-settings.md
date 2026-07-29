# Contract: Stop-hook settings (`--settings`)

Per-run inline JSON passed to `claude --settings '<json>'`. **Verified to fire in `-p` print mode on
v2.1.207** (research D2). Registers one `Stop` hook that enforces the completion contract (FR-022) and
is bounded by `stop_hook_active` (FR-023), plus one `PreToolUse` bash-guard hook (token-spend
problem 1, 2026-07-28) that denies sleep-dominant Bash commands.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command",
            "command": "node <abs>/packages/mcp-server/dist/bash-guard.js" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command",
            "command": "node <abs>/packages/mcp-server/dist/stop-hook.js <abs>/<run>.marker" }
        ]
      }
    ]
  }
}
```

The marker path is baked into the `command` (a path is not a secret). This same settings object also
neutralizes host `~/.claude/settings.json` leakage together with `--strict-mcp-config` (iteration-3
`args.ts` already passes an explicit `--settings`; for callback-wired runs it carries this Stop hook
instead of `{}`).

## Hook behavior (`stop-hook.js`)

Reads the hook event JSON from stdin. Let `active = input.stop_hook_active`.

```
if (markerFileExists)         → exit 0 (allow: complete_task / blocking request_human already ran)
else if (active === true)     → exit 0 (allow: BOUND reached — FR-023; FR-010 fail-closed catches it)
else                          → print {"decision":"block",
                                        "reason":"You must call mcp__brigadir__complete_task with your
                                                  final report, or mcp__brigadir__request_human, before
                                                  finishing."}  ; exit 0
```

**Prototype evidence (v2.1.207):** across one blocked session the hook fired twice —
`stop_hook_active=false` (we blocked) then `stop_hook_active=true` (we allowed) — confirming the
block is bounded to a single re-entry.

**Boundary of guarantee:** the hook is best-effort UX to nudge a cooperating agent. Correctness does
**not** depend on it — a run whose process ends `running` is finalized `failed` by FR-010
(`RunsService.failIfStillRunning`, research D7), independent of hook availability.

## Bash-guard hook behavior (`bash-guard.js`)

Token-spend problem 1 (analysis 2026-07-28): in-session sleep-polling burns a full cache-read turn
per check; waiting must END the session (`request_human(blocking=true)` / `complete_task`), never
loop inside it. Stateless — no argv; reads the PreToolUse event JSON from stdin
(`{tool_name, tool_input:{command}}`); anything that is not a Bash command string → silent allow.

Heuristic over the raw command string (no shell parsing, v1):

| Rule | Condition | Verdict |
|---|---|---|
| `loop_sleep` | a `sleep` occurrence AND a `while`/`until`/`for` keyword AND `done` in the same command | deny |
| `unparsable_sleep` | a `sleep` whose duration is not `N[s\|m\|h\|d]` (e.g. `sleep $DELAY`) | deny |
| `cumulative_sleep` | parsed sleep durations sum to > 15s | deny |
| — | otherwise (incl. short cushioning sleeps ≤ 15s) | allow |

On deny it prints the modern PreToolUse output shape and exits 0:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
  "permissionDecisionReason":"[brigadir-bash-guard] Denied: <detail>. <guidance>"}}
```

**Prefix contract:** every deny reason starts with the literal `[brigadir-bash-guard]`
(`BASH_GUARD_PREFIX` in `bash-guard-logic.ts`). The executor's stream parser matches this literal in
`user`/`tool_result` blocks and persists a `tool_denied` run_event
(`{name, command?, reason, truncated}`, scrubbed + capped per feature 026). The literal is
duplicated in `stream-parser.ts` (no cross-package import); both spec suites pin it.

**Fail-open:** every path exits 0 — a crashed or missing guard never blocks a run, and run
correctness never depends on it (same boundary of guarantee as the Stop hook). Known accepted v1
false positive: a space-preceded `sleep <n>` inside quoted prose (e.g. `echo "will sleep 600"`) is
denied; a quote-adjacent one (`grep "sleep 600"`) is not matched and passes.
