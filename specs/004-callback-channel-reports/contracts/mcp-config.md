# Contract: mcp-config file (stdio binding, `claude_cli`)

Per-run JSON file passed to `claude --mcp-config <path> --strict-mcp-config`. **Verified shape on
v2.1.207** (research D1). Written by the executor with mode **`0600`**, **outside the worktree**
(not in cwd / `--add-dir`), deleted at run cleanup.

```jsonc
{
  "mcpServers": {
    "brigadir": {
      "command": "node",
      "args": ["<abs path>/packages/mcp-server/dist/main.js"],
      "env": {
        "BRIGADIR_RUN_ID":      "<runId>",
        "BRIGADIR_CALLBACK_URL":"http://localhost:3000/api/callbacks",
        "BRIGADIR_RUN_TOKEN":   "<LITERAL signed JWT>",   // NOT ${VAR} — see D1
        "BRIGADIR_MARKER_PATH": "<abs path>/<run>.marker"
      }
    }
  }
}
```

## Rules (research D1, D3, D8)

- **Literal token, never `${BRIGADIR_RUN_TOKEN}` interpolation.** Prototype proved `${VAR}` expands
  from `claude`'s env, which the agent's Bash tool inherits (`printenv` leak). A literal `env` value
  reaches **only** the spawned `brigadir-mcp` child (`IS_UNSET` in the agent's Bash). This is the
  FR-004/FR-005 mechanism.
- Server name **`brigadir`** → the agent sees tools `mcp__brigadir__report_progress`,
  `mcp__brigadir__request_human`, `mcp__brigadir__complete_task`.
- These three tool names MUST be appended to `--allowed-tools` (D3).
- `--strict-mcp-config` ensures no host MCP servers leak into the run (Constitution V).
- The token is not in argv; `ps` reveals only the `--mcp-config <path>` flag.

## Tool → HTTP mapping (the `brigadir-mcp` server)

| MCP tool | Arg schema (`@brigadir/contracts`) | HTTP call |
|---|---|---|
| `report_progress` | `ReportProgressSchema` | `POST …/runs/$RUN_ID/progress` |
| `request_human` | `RequestHumanSchema` | `POST …/runs/$RUN_ID/human` |
| `complete_task` | `ReportSchema` (`CompleteTaskSchema`) | `POST …/runs/$RUN_ID/complete` |

Each handler sends `Authorization: Bearer $BRIGADIR_RUN_TOKEN`, returns the API's success/error
payload to the model (repair loop), and on 2xx of `complete_task` / blocking `request_human` writes
`$BRIGADIR_MARKER_PATH`. **stdout = MCP protocol only; all logs to stderr** (architecture §5).
Bounded retries on 5xx/network only (D9). Zero DB access.
