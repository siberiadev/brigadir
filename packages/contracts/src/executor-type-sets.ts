/**
 * Shared executor-type sets (feature 028, FR-016) — a DEP-FREE module (no
 * zod, no node builtins) so the web app can import these RUNTIME values from
 * TS source via the `@brigadir/contracts/executor-type-sets` alias instead of
 * the CJS barrel (same pattern as `pagination.constants.ts`; rollup cannot
 * trace names through the barrel's `__exportStar`). Server code keeps
 * importing them from the barrel — `executor.schema.ts` re-exports this file.
 *
 * Every rule that applies uniformly to "provider presets over the shared CLI
 * harness" or to "implicitly api_key-only preset types" keys off ONE of these
 * constants — never off per-type literal chains — so a fourth provider preset
 * extends a single definition.
 */

export const CLI_HARNESS_API_EXECUTOR_TYPES = ['claude_cli', 'kimi', 'deepseek_api'] as const;
export type CliHarnessApiExecutorType = (typeof CLI_HARNESS_API_EXECUTOR_TYPES)[number];
export function isCliHarnessApiExecutorType(type: string): type is CliHarnessApiExecutorType {
  return (CLI_HARNESS_API_EXECUTOR_TYPES as readonly string[]).includes(type);
}

export const API_KEY_ONLY_EXECUTOR_TYPES = ['kimi', 'deepseek_api'] as const;
export type ApiKeyOnlyExecutorType = (typeof API_KEY_ONLY_EXECUTOR_TYPES)[number];
export function isApiKeyOnlyExecutorType(type: string): type is ApiKeyOnlyExecutorType {
  return (API_KEY_ONLY_EXECUTOR_TYPES as readonly string[]).includes(type);
}

/**
 * Object-level variant of the guard above: narrows a request/config UNION to
 * its api_key-only branches. Needed because narrowing a union through a type
 * predicate on its discriminant PROPERTY is not supported by every TS
 * pipeline in the repo (the nest webpack build rejects it) — narrowing the
 * whole object is.
 */
export function isApiKeyOnlyExecutorRequest<T extends { type: string }>(
  req: T,
): req is Extract<T, { type: ApiKeyOnlyExecutorType }> {
  return isApiKeyOnlyExecutorType(req.type);
}
