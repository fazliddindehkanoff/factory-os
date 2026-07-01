import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function makeApp(rateLimit: boolean) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit });
}

describe('rate limiting', () => {
  it('enforces the auth limiter (10/min) when enabled', async () => {
    const app = await makeApp(true);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await request(app).post('/api/auth/dev').send({ telegramId: 'rl' });
      last = res.status;
    }
    expect(last).toBe(429);
  }, 20000);

  it('skips the limiter when rateLimit:false', async () => {
    const app = await makeApp(false);
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const res = await request(app).post('/api/auth/dev').send({ telegramId: 'rl2' });
      statuses.push(res.status);
    }
    expect(statuses.some((s) => s === 429)).toBe(false);
  }, 20000);
});
