# Contract: `run_events` `tool_call` payload

Producer: `ClaudeStreamParser.mapAssistant` → persisted verbatim by `claude-cli.executor.ts` `persistRunEvent`.
Consumer: `apps/web` timeline presenter.

## New shape (this feature)

```ts
type ToolCallPayload = {
  name: string;                     // assistant tool_use block name (e.g. "Bash", "mcp__brigadir__request_human")
  input: Record<string, unknown>;   // STRUCTURED — never a stringified blob
  truncated: boolean;               // true iff a generic string field was cut at MAX_FIELD_CHARS
};
```

### Sanitization invariants (applied to top-level string fields of `input`)

1. **Human-text fields** (`message`, `title`, `details`, `summary`) MUST be stored in full — never truncated. Each is passed through `scrub()`.
2. **File-content fields** (`content`, `new_string`, `old_string`) MUST be replaced by `"<file content, N KB>"` where `N = round(byteish_length / 1024)`. The original content is NOT stored.
3. **All other string fields** MUST be `scrub()`-ed and then capped at `MAX_FIELD_CHARS` (2000). If the value exceeded the cap, `truncated` MUST be `true`.
4. Non-string top-level values pass through unchanged. Nested arrays/objects pass through unchanged.
5. `truncated` is `true` ONLY for invariant-3 cuts. Invariant-2 placeholders MUST NOT set `truncated`.
6. The function is pure and total: any input object (including empty `{}`) yields a valid `ToolCallPayload`; it never throws.

### Signature

```ts
function sanitizeToolInput(
  name: string,
  rawInput: unknown,                // object from the tool_use block; non-objects → {}
  scrub: (s: string) => string,     // injected @brigadir/scrubber.scrub (identity in unit tests)
): { input: Record<string, unknown>; truncated: boolean };
```

## Legacy shape (pre-feature, read-only)

```ts
type LegacyToolCallPayload = { name: string; input: string /* JSON.stringify output, possibly cut at 500 */ };
```

Consumers MUST treat `typeof payload.input === 'string'` as legacy, render it as-is (monospace), and MUST NOT attempt to `JSON.parse`-repair a cut string. When `input.length >= 500`, consumers SHOULD surface an "input truncated by the executor" note.

## Compatibility

- Additive: adds `truncated`; changes `input` from `string` to `object` on the write path only. Old rows keep the legacy shape and are handled by the legacy branch.
- No `run_events` schema/migration change (`payload` is `jsonb`).
