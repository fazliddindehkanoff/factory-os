/** Validated environment config. Fails fast at boot if required vars are missing. */
import { z } from 'zod';

// A secret must be reasonably long and must NOT be a known placeholder.
const PLACEHOLDER = /change_me|dev_only/i;
const strongSecret = (name: string) =>
  z
    .string()
    .min(16, `${name} must be at least 16 characters`)
    .refine((v) => !PLACEHOLDER.test(v), `${name} must not be a placeholder — set a real secret`);

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BOT_TOKEN: z.string().default(''),
  APP_URL: z.string().optional(),
  SESSION_SECRET: strongSecret('SESSION_SECRET'),
  PIN_PEPPER: strongSecret('PIN_PEPPER'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('production'),
  ENABLE_DEV_AUTH: z.string().optional(),
  SERVE_DESIGN: z.string().optional(),
  SNAB_DASHBOARD_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const env = schema.parse(process.env);
  // P0.4: outside development, refuse dangerous implicit defaults.
  if (env.NODE_ENV !== 'development') {
    if (env.SERVE_DESIGN === undefined) {
      throw new Error(
        'SERVE_DESIGN must be set explicitly outside development (use SERVE_DESIGN=0 to serve the React app).',
      );
    }
    if (env.ENABLE_DEV_AUTH === '1') {
      throw new Error('ENABLE_DEV_AUTH=1 is not allowed outside development.');
    }
  }
  return env;
}

/**
 * Dev login is allowed ONLY in an explicit development environment.
 * Fail-closed: NODE_ENV defaults to 'production' (above), so an unset or
 * misconfigured server keeps dev auth OFF. Enabling it requires deliberately
 * running NODE_ENV=development together with ENABLE_DEV_AUTH=1 — and loadEnv()
 * refuses to boot if ENABLE_DEV_AUTH=1 leaks into any non-development env.
 */
export function devAuthEnabled(env: Env): boolean {
  return env.NODE_ENV === 'development' && env.ENABLE_DEV_AUTH === '1';
}
