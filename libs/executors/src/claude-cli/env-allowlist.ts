/**
 * Explicit allowlist of env keys ever copied into the spawned `claude`
 * process (research D6, Constitution V). Never `...process.env` — anything
 * not named here (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, AWS_*, GCP_*,
 * OPENAI_*, Jira tokens, `*_TOKEN`/`*_SECRET`/`*_KEY`, DB/Redis URLs, ...)
 * simply cannot leak through, by construction of the allowlist rather than
 * by pattern-matching secrets out of a denylist.
 */
const ALLOWLIST_KEYS = [
  // Needed for `claude` to run at all and read ~/.claude subscription auth.
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  // git identity, if configured on the worker host.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  // SSH agent socket (live incident 2026-07-14): repositories are cloned over
  // SSH (private GitHub; https has no credential source in a headless spawn),
  // and agents must push branches/PRs from their worktree. Trusted-team
  // posture (plan-internal: no sandboxes) — the agent gets the host user's
  // ssh-agent, same as any local script. Revisit if sandboxing ever lands.
  'SSH_AUTH_SOCK',
  // Test-harness control channel for the substitutable fake `claude` binary
  // (research D8, test/fixtures/claude-cli/fake-claude.mjs). Harmless in
  // production: these names never exist in a real worker environment, and
  // listing them explicitly is what lets the security test (T085) prove the
  // allowlist floor holds even with the harness wired through the same path.
  'FAKE_CLAUDE_FIXTURE',
  'FAKE_CLAUDE_ENV_DUMP',
  'FAKE_CLAUDE_ARGV_DUMP',
  'FAKE_CLAUDE_SPAWN_CHILD',
  'FAKE_CLAUDE_CHILD_PID_FILE',
  'FAKE_CLAUDE_SELF_PID_FILE',
  'FAKE_CLAUDE_STDERR_TEXT',
  'FAKE_CLAUDE_EXIT_CODE',
  'FAKE_CLAUDE_LINE_DELAY_MS',
  // Feature 004 (T096): scripted callback sequence for the fake CLI's
  // callback mode — same harmless-in-production posture as the rest.
  'FAKE_CLAUDE_CALLBACKS',
] as const;

/**
 * Build the sanitized child env from the worker's own `process.env`-shaped
 * object. Pure — no I/O, never mutates or spreads the input.
 */
export function buildChildEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWLIST_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}
