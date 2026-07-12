# Contract: Credentials Codec envelope (Feature 005)

**Seam**: `libs/jira/src/credentials.codec.ts` — `encodeJiraCredentials` /
`decodeJiraCredentials` (function signatures unchanged; behavior upgraded). Backs
Constitution Principle V "credentials at rest … AES-256-GCM".

## Key

- Env: **`BRIGADIR_CREDENTIALS_KEY`** — 32 bytes, accepted as base64 or hex; decoded
  length **must** be 32 (else fail-fast at resolution).
- Resolved via a DI provider (`credentials-key.provider.ts`, mirrors
  `jwt-secret.provider.ts`) — never at `@Module()` composition (lazy-resolution rule).
- **FR-023 fail-fast:** encrypting, or decrypting an **encrypted-format** blob, with the
  key absent/malformed throws `CredentialsKeyMissingError`. No plaintext fallback.

## Envelope (bytes stored in `workspaces.jira_credentials bytea`)

```
┌──────────┬───────────────┬────────────────────┬────────────────────────┐
│ version  │ IV (nonce)    │ GCM auth tag       │ ciphertext             │
│ 1 byte   │ 12 bytes      │ 16 bytes           │ n bytes                │
│ 0x01     │ random/msg    │ cipher.getAuthTag  │ AES-256-GCM(plaintext) │
└──────────┴───────────────┴────────────────────┴────────────────────────┘
```
- **Plaintext** = `JSON.stringify(JiraCredentialsSchema.parse({ email, api_token }))`
  (same object as the legacy format).
- **Cipher** = `aes-256-gcm` (`node:crypto.createCipheriv`), fresh random 12-byte IV
  per encryption. Auth tag verified on decrypt (tamper → throw, never silent).

## Decode: format-sniffing (never lose the ability to authenticate — R2)

`decodeJiraCredentials(blob)` branches on `blob[0]`:
- `0x01` → **encrypted path**: requires key; slice IV/tag/ciphertext, GCM-decrypt,
  parse JSON, validate `JiraCredentialsSchema`.
- `0x7b` (`{`) → **legacy plaintext path**: parse JSON directly (current behavior);
  key **not** required — an operator who upgraded the binary before setting the key can
  still authenticate until the boot migration re-encrypts.
- anything else (e.g. the iteration-1 `placeholder-jira-credentials` bytes) → throw
  `JiraAuthError` (unchanged — unrecoverable, not a silent fallback).

## Encode: always encrypted

`encodeJiraCredentials(creds)` → version-`0x01` envelope. Requires the key (fail-fast).
Every write path (create, rotate, settings) goes through this, so new/rotated rows are
encrypted by construction.

## Legacy migration (FR-022)

One-shot at boot (`main.api.ts`, after migrations/seed): scan `workspaces`; for each row
whose `jira_credentials[0]` is the legacy `{` byte, re-encrypt and rewrite. Idempotent
(encrypted rows skipped by the version-byte sniff). Requires the key; if the key is
absent the migration is skipped with a logged warning and legacy rows stay authenticable
via the decode plaintext path (they get migrated on the first boot that has the key).

## Test obligations (Principle VI — contract tests)

- round-trip: `decode(encode(c)) === c`.
- envelope: encoded blob starts `0x01`; length ≥ 1+12+16; not human-readable (no `email`
  substring in bytes).
- tamper: flip one ciphertext byte → decrypt throws (auth-tag failure).
- legacy: a `{"email":…}` blob decodes without the key; re-encoding it yields `0x01`.
- fail-fast: encrypt / encrypted-decrypt with unset key throws `CredentialsKeyMissingError`.
- placeholder bytes still throw `JiraAuthError`.
