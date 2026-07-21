# Contract: Channel-Failure Breadcrumb Protocol (mcp-server ↔ worker)

Two parties, one directory, no shared code at runtime (the mcp-server stays
dependency-free; the zod schema lives in `@brigadir/contracts` and is
enforced by the reader).

## Directory & naming

- Dir: `<configRoot>/.brigadir-channel/` — sibling of `.brigadir-outbox/`.
  - Writer resolves `configRoot` as `dirname(BRIGADIR_MARKER_PATH)`.
  - Reader resolves it as `resolveMcpConfigRoot()`
    (`BRIGADIR_MCP_CONFIG_ROOT` else `<os.tmpdir()>/brigadir/mcp-config`).
  - These MUST agree (they do today via the outbox convention; any change to
    one side is a breaking change to this contract).
- File: `<runId>.jsonl` (runId = UUID, filename stem is authoritative).
- Claimed file: `<runId>.jsonl.ingesting` (rename target during ingestion).

## Writer obligations (packages/mcp-server)

- Append exactly one line per **retry exhaustion** of a callback tool
  delivery (both budgets: network-throw exhaustion and 5xx exhaustion).
  Never per attempt.
- Line = JSON object `ChannelBreadcrumbRecord`:
  ```json
  {
    "ts": "2026-07-21T12:34:56.789Z",
    "tool": "report_progress",
    "kind": "network",
    "attempts": 11,
    "error": { "name": "TypeError", "message": "fetch failed" },
    "status": 502,            // optional, kind="http" only
    "target": "127.0.0.1:3210"
  }
  ```
- `target` is host:port ONLY. Never full URLs, paths, query strings, headers,
  tokens, or request/response bodies.
- Best-effort posture (identical to the outbox writer): mkdir+append wrapped
  in try/catch, never throws, never delays or alters the tool result the
  agent sees. Failure to write is at most a stderr line.
- Volume bound: if the file already exceeds **65536 bytes**, skip the append
  (silently). No rotation, no truncation of existing content.
- The writer never reads, renames, or deletes files in this directory.

## Reader obligations (worker)

- Ingestion triggers: (1) every terminal branch of a callback-wired run's
  process exit; (2) the periodic outbox-reconcile pass, for files whose
  runId resolves to a run in a **terminal** status. Files of active runs
  (`queued` / `running` / `awaiting_human`) are left untouched.
- Claim protocol: atomic `rename(f, f + '.ingesting')`. Rename success =
  exclusive ownership; ENOENT = another path won — no-op, никогда не ошибка.
  This is the sole idempotency mechanism; no DB-side dedup exists.
- Per line: parse JSON → validate `ChannelBreadcrumbRecordSchema` → scrub
  `error.message` through the secret scrubber → insert one `run_events` row
  `type='channel_failure'`, payload = record + `{ occurred_at: ts, source:
  'exit' | 'reconcile' }`. Invalid lines: drop with warn-once, continue.
- After processing all lines: delete the claimed file (best-effort `rm`).
- Unknown/invalid runId filenames and orphaned `.ingesting` files: retained
  `BRIGADIR_OUTBOX_RETENTION_MS` (default 7 d), then deleted with a log line
  (same posture and constants as the 026 outbox reconciler).
- Ingestion NEVER writes `runs.status`/`outcome` and never throws into the
  run-finalization path (wrapped best-effort).

## Compatibility rules

- Additive record fields are allowed (reader must ignore unknown keys).
- Removing/renaming fields or changing the directory name is breaking and
  requires a coordinated mcp-server + worker change (deployment guard
  already forces artifact freshness on one host).
- Phase-0 runs never produce these files (no callback channel, no marker
  path usage by callback tools).
