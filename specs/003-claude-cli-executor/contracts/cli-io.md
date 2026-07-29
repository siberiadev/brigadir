# Contract — claude_cli Process I/O

Frozen boundary between `ClaudeCliExecutor` and the spawned `claude` process.
The fake CLI (D8) MUST honor the input half; the executor MUST tolerate the
output half exactly as specified (resilience: FR-014).

## Spawn (D2, D7)

```
spawn(cliPath, argv, {
  cwd: <worktreeDir>,          // RunContext.workspaceDir (D3)
  env: <allowlist>,            // built in code, NO ...process.env (D6)
  detached: true,              // process-group leader
  stdio: ['pipe','pipe','pipe']
})
```
- Kill = `process.kill(-child.pid, 'SIGTERM')` → grace `killGraceMs` →
  `SIGKILL`; guard `ESRCH`.
- **No `shell:true`.**

## argv (built by `args.ts`, contains NO secret, NO ticket body)

```
-p
--output-format stream-json --verbose
--json-schema <ReportSchema-as-JSON-Schema>
--model <cfg.model>
--append-system-prompt-file <worktree>/.brigadir/wrapper.txt
--allowed-tools <resolved,comma,list>
--strict-mcp-config
--settings <inline hardening JSON>
--permission-mode dontAsk
[--disallowed-tools ScheduleWakeup]   // callback-wired runs only (token-spend
                                      // problem 1: the CLI auto-allows the tool
                                      // under dontAsk; wakeup-polling costs a
                                      // full cache-read turn per check)
[--max-turns <n>] [--max-budget-usd <n>]
```

## stdin

The wrapped instruction / task text (arbitrary ticket content) is written to
`child.stdin` then closed. Never an argv element (FR-018, D7).

## Output consumed (stdout NDJSON, one JSON per line)

| Event | Shape (fields consumed) | Executor action |
|---|---|---|
| `system`/`init` | `session_id`, `model`, `tools`, `mcp_servers` | `externalRef=session_id`; `run_events(log)` |
| assistant msg w/ `tool_use` | tool `name`, `input` | `run_events(tool_call)` (bounded) |
| assistant msg w/ text | text | `run_events(progress)` (sampled, truncated) |
| `user` msg w/ `tool_result` containing `[brigadir-bash-guard]` | `tool_use_id`, result text | `run_events(tool_denied)` (bounded payload `{name, command?, reason, truncated}`); every other `user` event is still ignored |
| `system`/`api_retry` | `error`, `retry_delay_ms`, `attempt`, `max_retries` | if `error=="rate_limit"` → `run_events(api_retry)`, capture ttl, group-kill, `exitStatus:'rate_limited'` (D5) |
| `result` (terminal) | `subtype`, `is_error`, `total_cost_usd`, `usage`, `structured_output`, `result` | capture cost/usage; report = `structured_output` (D1) |

**Report extraction (D1):** `report = result.structured_output`, re-validated by
zod `ReportSchema`. If missing/invalid → `exitStatus:'completed'` **without**
`report` + diagnostic → processor finalizes `failed` (FR-008). *(No fallback
exists: the D1 prototype (CLI v2.1.207, 2026-07-11) confirmed `structured_output`
IS present on the stream-json terminal event — fail-closed only, never parse
`result.result` text.)*

**Malformed line:** `JSON.parse` in try/catch; a bad/partial line is skipped, the
run continues (FR-014).

## stderr

Bounded ring buffer (~16 KB tail) → `runs.error` on failure (FR-013).

## Exit → `ExecutorResult.exitStatus` (D14, arch §4)

| Condition | exitStatus |
|---|---|
| clean exit, valid report captured | `completed` (+`report`) |
| clean exit, no/invalid report | `completed` (no `report`) → failed |
| nonzero exit / budget crossed | `crashed` (budget → diagnostic) |
| timeout fired | `timeout` |
| rate_limit event | `rate_limited` (+ttl) |
| cancel observed | `cancelled` |

Single-finalize guard: first terminal cause wins; `run()` resolves once (D12).
