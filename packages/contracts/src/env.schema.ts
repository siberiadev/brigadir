import { z } from 'zod';
import {
  ENV_KEY_REGEX,
  ENV_TOTAL_MAX_BYTES,
  ENV_VALUE_MAX_BYTES,
  envByteLength,
  isReservedEnvKey,
} from './env.constants';

/**
 * Env-variable contracts for agent runs (feature 031). Constants and the
 * reserved-key rule live in the dep-free `env.constants.ts`; this module adds
 * the zod validation that the dashboard and admin-MCP write paths share.
 *
 * Non-secret env is a `Record<string,string>` stored openly in the settings /
 * behavior jsonb blobs; secret values travel through the sealed env-secrets
 * blob and are validated with the SAME value rules via {@link EnvMapSchema}.
 */

/** A single env key: format-valid and NOT platform-reserved. */
export const EnvKeySchema = z
  .string()
  .regex(ENV_KEY_REGEX, 'env key must match /^[A-Za-z_][A-Za-z0-9_]*$/')
  .refine((k) => !isReservedEnvKey(k), { message: 'env key is reserved by the platform' });

/** A single env value: within the per-value byte cap; empty string allowed. */
export const EnvValueSchema = z
  .string()
  .refine((v) => envByteLength(v) <= ENV_VALUE_MAX_BYTES, {
    message: `env value exceeds ${ENV_VALUE_MAX_BYTES} bytes`,
  });

/**
 * A map of env entries for ONE scope. Every key format-valid + non-reserved,
 * every value within the per-value cap, and the summed serialized size within
 * the per-run merged cap. Reserved/invalid keys carry a message that names the
 * offending key (contract §1 error shape).
 */
export const EnvMapSchema = z
  .record(z.string(), z.string())
  .superRefine((map, ctx) => {
    let total = 0;
    for (const [key, value] of Object.entries(map)) {
      if (!ENV_KEY_REGEX.test(key)) {
        ctx.addIssue({ code: 'custom', message: `env key "${key}" is invalid`, path: [key] });
      } else if (isReservedEnvKey(key)) {
        ctx.addIssue({ code: 'custom', message: `env key "${key}" is reserved`, path: [key] });
      }
      const valueBytes = envByteLength(value);
      if (valueBytes > ENV_VALUE_MAX_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: `env value for "${key}" exceeds ${ENV_VALUE_MAX_BYTES} bytes`,
          path: [key],
        });
      }
      total += envByteLength(key) + valueBytes;
    }
    if (total > ENV_TOTAL_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `env for scope exceeds ${ENV_TOTAL_MAX_BYTES} bytes` });
    }
  });
export type EnvMap = z.infer<typeof EnvMapSchema>;

/** A UI/admin write row: key + value + the secret-routing flag. */
export const EnvWriteRowSchema = z
  .object({
    key: EnvKeySchema,
    value: EnvValueSchema,
    secret: z.boolean(),
  })
  .strict();
export type EnvWriteRow = z.infer<typeof EnvWriteRowSchema>;
