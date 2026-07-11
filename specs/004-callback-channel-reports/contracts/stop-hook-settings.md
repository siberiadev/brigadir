# Contract: Stop-hook settings (`--settings`)

Per-run inline JSON passed to `claude --settings '<json>'`. **Verified to fire in `-p` print mode on
v2.1.207** (research D2). Registers one `Stop` hook that enforces the completion contract (FR-022) and
is bounded by `stop_hook_active` (FR-023).

```jsonc
{
  "hooks": {
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
