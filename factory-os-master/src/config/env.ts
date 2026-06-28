/** Validated environment config. Fails fast at boot if required vars are missing. */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BOT_TOKEN: z.string().default(''),
  APP_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(8, 'SESSION_SECRET must be at least 8 chars'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),
  ENABLE_DEV_AUTH: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  return schema.parse(process.env);
}
