import { Provider } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentsConfigSchema, type AgentsConfig } from '@brigadir/contracts';

/**
 * Fail-fast agents.yaml provider (T015).
 *
 * Reads AGENTS_CONFIG_PATH (default ./agents.yaml), parses YAML, and validates
 * with AgentsConfigSchema. Any failure — missing file, unparseable YAML, or a
 * ZodError — is re-thrown as a fatal AgentsConfigError naming the resolved file
 * path plus the dot-joined zod issue path, BEFORE Nest finishes bootstrapping
 * (research D6 / spec FR-013). The bootstrap wrapper turns this into a non-zero
 * exit with no partial boot.
 */

export const AGENTS_CONFIG = Symbol('AGENTS_CONFIG');
export const DEFAULT_AGENTS_CONFIG_PATH = './agents.yaml';

export class AgentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentsConfigError';
  }
}

export function resolveAgentsConfigPath(): string {
  return process.env.AGENTS_CONFIG_PATH ?? DEFAULT_AGENTS_CONFIG_PATH;
}

export function loadAgentsConfig(path: string = resolveAgentsConfigPath()): AgentsConfig | null {
  const abs = resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    // Feature 005 (FR-019): an ABSENT yaml is optional — the DB is now
    // authoritative for config, so boot cleanly on DB-only config. Any OTHER
    // read error (permissions, etc.) still fails fast.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new AgentsConfigError(
      `agents config not readable at ${abs}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new AgentsConfigError(`agents config at ${abs} is not valid YAML: ${(err as Error).message}`);
  }

  const result = AgentsConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new AgentsConfigError(`agents config at ${abs} failed validation:\n${issues}`);
  }

  return result.data;
}

/**
 * DI provider that loads+validates the config eagerly at module init. An absent
 * yaml resolves to `null` (DB-authoritative boot, FR-019); a present-but-invalid
 * yaml still fails fast. Injectors must tolerate `null` (AGENTS_CONFIG may be
 * absent when the operator runs DB-only).
 */
export const agentsConfigProvider: Provider = {
  provide: AGENTS_CONFIG,
  useFactory: (): AgentsConfig | null => loadAgentsConfig(),
};
