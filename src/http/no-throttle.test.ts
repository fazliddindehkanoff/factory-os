import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema.js';
import { createApp } from '../server/app.js';

describe('HTTP throttling is disabled', () => {
  it('never converts repeated API or authentication requests into 429 responses', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    const app = createApp({
      db,
      botToken: 'test:token',
      sessionSecret: 'test-secret-long-enough',
      devAuth: false,
    });

    for (let attempt = 0; attempt < 140; attempt += 1) {
      const response = await request(app).get('/api/requests');
      expect(response.status).toBe(401);
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await request(app).post('/api/auth/telegram').send({ initData: 'invalid' });
      expect(response.status).toBe(401);
    }
  });
});
