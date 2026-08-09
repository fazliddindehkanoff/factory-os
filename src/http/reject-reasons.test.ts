/**
 * Bug #3: role-based rejection reasons. Seeded system defaults are returned for the
 * current step's role (plus generic), configurable later per holding.
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
import { createRequest } from '../services/request.service.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const roleId = async (c: string) => (await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, c))))[0].id as string;
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId('warehouse') });
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true });
  const user = async (tg: string, code: string) => {
    const login = await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200);
    const uid = login.body.user.id as string;
    await db.update(schema.users).set({ holdingId: holding.id, status: 'active' }).where(eq(schema.users.id, uid));
    await db.insert(schema.userRoles).values({ userId: uid, roleId: await roleId(code), holdingId: holding.id });
    return { uid, token: login.body.token as string };
  };
  return { app, db, holding, factory, user };
}

describe('bug #3: rejection reasons', () => {
  it('seeds system defaults', async () => {
    const { db } = await make();
    const rows = await db.select().from(schema.rejectionReasons).where(isNull(schema.rejectionReasons.holdingId));
    expect(rows.length).toBeGreaterThan(5);
    // FIXES 2026-07-17 (лист D): у склада осталась одна ролевая причина.
    expect(rows.some((r: any) => r.roleCode === 'warehouse' && r.text === 'Требуется уточнение по позиции')).toBe(true);
    // FIXES 2026-07-17 (лист G): пресеты «Пересмотреть цену» (псевдо-роль).
    expect(rows.some((r: any) => r.roleCode === 'price_review' && r.text === 'Завышенная цена')).toBe(true);
  });

  it('returns warehouse reasons + generic for a request on the warehouse step', async () => {
    const { app, db, holding, factory, user } = await make();
    const wh = await user('wh', 'warehouse');
    const author = await user('author', 'requester');
    const req = await createRequest(db, { holdingId: holding.id, requesterId: author.uid, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    const res = await request(app).get(`/api/requests/${req.id}/reject-reasons`).set('Authorization', `Bearer ${wh.token}`).expect(200);
    // FIXES 2026-07-17 (лист D): склад — «Требуется уточнение по позиции» + общие.
    expect(res.body.reasons).toContain('Требуется уточнение по позиции'); // warehouse-specific
    expect(res.body.reasons).toContain('Ошибочная заявка'); // generic (roleCode null)
    expect(res.body.reasons).not.toContain('Нет на складе'); // выключена (лист D)
    expect(res.body.reasons).not.toContain('Завышенная цена'); // псевдо-роль price_review — только для action=return_research
    expect(res.body.reasons).not.toContain('Превышает лимит'); // director-only, not for warehouse step

    // FIXES 2026-07-17 (лист G): у «Пересмотреть цену» свой список причин.
    const priceRes = await request(app)
      .get(`/api/requests/${req.id}/reject-reasons?action=return_research`)
      .set('Authorization', `Bearer ${wh.token}`)
      .expect(200);
    expect(priceRes.body.reasons).toEqual(['Завышенная цена', 'Найти других поставщиков', 'Найти на перечисление', 'Сделать конкурентный лист']);
  });
});
