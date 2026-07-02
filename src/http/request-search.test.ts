/**
 * P1-7: GET /requests search/filter runs server-side, so it finds requests beyond
 * the first page and returns an accurate total.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function makeApp() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return { app: createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false }), db };
}

async function roleId(db: any, code: string): Promise<string> {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

describe('P1-7: server-side request search', () => {
  it('finds a request that is not on the first page, and reports total', async () => {
    const { app, db } = await makeApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const login = await request(app).post('/api/auth/dev').send({ telegramId: '900' }).expect(200);
    const token = login.body.token as string;
    const userId = login.body.user.id as string;
    await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, userId));
    await db.insert(schema.userRoles).values({ userId, roleId: await roleId(db, 'owner'), holdingId: h.id });

    // 40 requests; only one has the needle in its title, and it sorts late by createdAt.
    for (let i = 0; i < 40; i++) {
      await db.insert(schema.requests).values({
        requestNumber: `R-${String(i).padStart(3, '0')}`,
        holdingId: h.id,
        requesterId: userId,
        title: i === 5 ? 'UNIQUE-NEEDLE cotton' : `bulk ${i}`,
        status: 'pending_approval',
      });
    }

    // Page 1 (limit 30) would NOT include R-005 by recency in a real ordering, but
    // the server-side search must find it regardless of page.
    const res = await request(app)
      .get('/api/requests?search=UNIQUE-NEEDLE&limit=30')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].requestNumber).toBe('R-005');
  });

  it('filters by status server-side', async () => {
    const { app, db } = await makeApp();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const login = await request(app).post('/api/auth/dev').send({ telegramId: '901' }).expect(200);
    const token = login.body.token as string;
    const userId = login.body.user.id as string;
    await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, userId));
    await db.insert(schema.userRoles).values({ userId, roleId: await roleId(db, 'owner'), holdingId: h.id });

    for (const s of ['pending_approval', 'pending_approval', 'closed']) {
      await db.insert(schema.requests).values({
        requestNumber: `S-${Math.random().toString(36).slice(2, 7)}`,
        holdingId: h.id,
        requesterId: userId,
        status: s,
      });
    }

    const res = await request(app)
      .get('/api/requests?status=closed')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items.every((r: any) => r.status === 'closed')).toBe(true);
  });
});
