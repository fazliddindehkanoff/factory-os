/** Test-mode role switcher endpoint: stealth in prod, seeded users in dev. */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedTest, TEST_USERS } from '../db/seed-test.js';
import { createApp } from '../server/app.js';

const SECRET = 'test-secret-long-enough';

async function makeApp(devAuth: boolean) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedTest(db);
  return { app: createApp({ db, botToken: 'test:token', sessionSecret: SECRET, devAuth }), db };
}

describe('GET /api/dev/users (test-mode role switcher)', () => {
  it('is a stealth 404 when dev auth is off (production shape)', async () => {
    const { app } = await makeApp(false);
    await request(app).get('/api/dev/users').expect(404);
  });

  it('lists the seeded test users with their role names when dev auth is on', async () => {
    const { app, db } = await makeApp(true);
    await db.insert(schema.users).values({ telegramId: 'orphan_01', fullName: 'Roleless Dev User', status: 'active' });
    const res = await request(app).get('/api/dev/users').expect(200);
    expect(res.body.pin).toBeTruthy();
    const usernames = res.body.users.map((u: { username: string }) => u.username);
    expect(usernames).toEqual(TEST_USERS.map((u) => u.username));
    expect(res.body.users.map((u: { phone: string }) => u.phone)).toEqual(TEST_USERS.map((u) => u.phone));
    expect(usernames).not.toContain('orphan_01');
    for (const u of res.body.users as { roles: string[] }[]) {
      expect(u.roles.length).toBeGreaterThan(0);
    }
  });

  it('each seeded user can log in via /api/auth/dev and read /me with permissions', async () => {
    const { app } = await makeApp(true);
    for (const spec of TEST_USERS) {
      const login = await request(app)
        .post('/api/auth/dev')
        .send({ telegramId: spec.username })
        .expect(200);
      const me = await request(app)
        .get('/api/me')
        .set('Authorization', `Bearer ${login.body.token}`)
        .expect(200);
      expect(me.body.user.fullName).toBe(spec.name);
      expect(me.body.permissions.length).toBeGreaterThan(0);
    }
  });

  it('logs into the existing test account by a normalized phone and never creates one for an unknown web login', async () => {
    const { app, db } = await makeApp(true);
    const spec = TEST_USERS[1];
    const formatted = `+${spec.phone.slice(0, 3)} ${spec.phone.slice(3, 5)} ${spec.phone.slice(5, 8)} ${spec.phone.slice(8, 10)} ${spec.phone.slice(10)}`;
    const login = await request(app).post('/api/auth/dev').send({ login: formatted }).expect(200);
    const me = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(200);
    expect(me.body.user.fullName).toBe(spec.name);

    await request(app).post('/api/auth/dev').send({ login: '+998 90 999 99 99' }).expect(404);
    const roleless = await db.select().from(schema.users).where(eq(schema.users.telegramId, '+998 90 999 99 99'));
    expect(roleless).toHaveLength(0);
  });
});
