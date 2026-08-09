/**
 * P2-2: changing an existing PIN requires the current PIN. A stolen session must
 * not be enough to reset the signing PIN. First-time set needs no old PIN.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
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
  return { app: createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true }), db };
}

async function setupUser(app: any, db: any, tgId: number) {
  const [h] = await db.insert(schema.holdings).values({ name: `H${tgId}` }).returning();
  const login = await request(app).post('/api/auth/dev').send({ telegramId: String(tgId) }).expect(200);
  const token = login.body.token as string;
  const userId = login.body.user.id as string;
  await db.update(schema.users).set({ holdingId: h.id, status: 'active' }).where(eq(schema.users.id, userId));
  return { token, userId, holdingId: h.id };
}

describe('P2-2: PIN change requires old PIN', () => {
  it('first-time PIN set needs no old PIN and writes an audit row', async () => {
    const { app, db } = await makeApp();
    const { token, userId, holdingId } = await setupUser(app, db, 501);

    await request(app).post('/api/me/pin').set('Authorization', `Bearer ${token}`).send({ pin: '1234' }).expect(200);

    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
    expect(audits.some((a: any) => a.action === 'pin.set')).toBe(true);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u.pinHash).toBeTruthy();
    void holdingId;
  });

  it('rejects changing PIN without the correct old PIN', async () => {
    const { app, db } = await makeApp();
    const { token, userId } = await setupUser(app, db, 502);
    await request(app).post('/api/me/pin').set('Authorization', `Bearer ${token}`).send({ pin: '1111' }).expect(200);

    // No old PIN → 403
    await request(app).post('/api/me/pin').set('Authorization', `Bearer ${token}`).send({ pin: '2222' }).expect(403);
    // Wrong old PIN → 403
    await request(app)
      .post('/api/me/pin')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '2222', oldPin: '9999' })
      .expect(403);

    // PIN unchanged (still verifies against 1111 via a correct change below).
    const ok = await request(app)
      .post('/api/me/pin')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '2222', oldPin: '1111' })
      .expect(200);
    expect(ok.body.ok).toBe(true);

    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, userId));
    expect(audits.some((a: any) => a.action === 'pin.changed')).toBe(true);
  });
});
