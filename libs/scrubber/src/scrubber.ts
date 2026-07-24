/**
 * Secret scrubber (FR-024, libs/scrubber). Pure — no I/O. Redacts known
 * secret-shaped patterns (regex) plus a Shannon-entropy heuristic for long
 * high-entropy substrings that don't match a named pattern. Applied to every
 * agent free-text field before persistence and before any Jira write.
 *
 * Not exhaustive by design (spec.md Assumptions — "known patterns are", not
 * a claim of complete secret coverage).
 */

export const REDACTED = '[REDACTED]';

interface NamedPattern {
  name: string;
  regex: RegExp;
}

// Key=value / "key": "value" assignments whose NAME ends in _TOKEN/_SECRET/_KEY
// (env-var style). Redacts only the value, keeping the key name for context.
const ASSIGNMENT_RE =
  /\b([A-Z][A-Z0-9]*_(?:TOKEN|SECRET|KEY))\s*([:=])\s*(['"]?)([^\s'",;]{8,})\3/g;

const KNOWN_SECRET_PATTERNS: NamedPattern[] = [
  // Anthropic/OpenAI-style API keys: sk-..., sk-ant-..., sk-proj-...
  { name: 'sk-style-api-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_
  { name: 'github-token', regex: /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g },
  // AWS access key id
  { name: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT-shaped bearer tokens: three base64url segments, header starts eyJ ("{\"" b64)
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
];

// Candidate spans for the entropy heuristic: contiguous token-like runs with
// no spaces/dots/slashes (so URLs and dotted identifiers split into short,
// low-entropy fragments naturally rather than being swept in whole).
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9_+=-]{32,}/g;
// 4.5 sits in the gap between long camelCase identifiers (~4.1-4.2 bits/char,
// e.g. "resolveClaudeCliConfigFromExecutorRow") and truly random tokens
// (~5.3+ bits/char) — measured empirically, not a formal bound.
const ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redactHighEntropySpans(text: string): string {
  return text.replace(ENTROPY_CANDIDATE_RE, (span) =>
    shannonEntropy(span) >= ENTROPY_THRESHOLD_BITS_PER_CHAR ? REDACTED : span,
  );
}

/** Redact known secret patterns and high-entropy substrings from free text. */
export function scrub(text: string): string {
  let out = text.replace(ASSIGNMENT_RE, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  for (const { regex } of KNOWN_SECRET_PATTERNS) {
    out = out.replace(regex, REDACTED);
  }
  out = redactHighEntropySpans(out);
  return out;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Feature 031: build a scrub function that ALSO redacts exact occurrences of
 * the given literals (a run's decrypted secret env values) before delegating to
 * the global {@link scrub}. Needed because a secret env value may be a short or
 * low-entropy string (e.g. a dictionary password) that neither the named
 * patterns nor the entropy heuristic would catch — FR-007 demands zero leakage
 * of the ACTUAL configured values.
 *
 * Literals shorter than 4 chars are ignored (too collision-prone to redact
 * safely); empty input yields a plain wrapper equivalent to {@link scrub}. The
 * global `scrub` is unchanged, so every existing call site is unaffected.
 */
export function makeScrub(extraLiterals: string[]): (text: string) => string {
  const literals = [...new Set(extraLiterals.filter((s) => s.length >= 4))]
    // Redact longer literals first so a secret that contains another as a
    // substring is fully masked rather than partially.
    .sort((a, b) => b.length - a.length);
  if (literals.length === 0) return scrub;
  const literalRe = new RegExp(literals.map(escapeRegExp).join('|'), 'g');
  return (text: string): string => scrub(text.replace(literalRe, REDACTED));
}
