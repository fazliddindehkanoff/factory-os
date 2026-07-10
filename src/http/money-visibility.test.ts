/**
 * Видимость сумм (bug цены, 2026-07-07): единый гейт getMoneyVisibility.
 *  - Денежные права (procurement.* / finance.* / audit.view) → суммы видны всегда.
 *  - Согласующий, чей шаг стоит НЕ РАНЬШЕ первого шага закупки, видит суммы и КП
 *    этого маршрута даже без денежных прав (кастомные роли вроде «Исп дир»).
 *  - Роли до закупки (рук. отдела, склад) сумм не видят.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from '../services/request.service.js';
import { getMoneyVisibility } from './request-visibility.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();

  const sysRoleId = async (code: string): Promise<string> => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id;
  };
  // Кастомная роль холдинга «Исп дир»: только согласование, БЕЗ денежных прав —
  // ровно как пустая роль bobur на проде Zelal.
  const [execRole] = await db.insert(schema.roles).values({ holdingId: holding.id, code: 'execdir', name: 'Исп дир' }).returning();
  const perms = await db
    .select()
    .from(schema.permissions)
    .where(inArray(schema.permissions.code, ['approvals.approve', 'requests.view']));
  for (const p of perms) await db.insert(schema.rolePermissions).values({ roleId: execRole.id, permissionId: p.id });

  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', stepKind: 'approval', approverRoleId: await sysRoleId('dept_head') },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await sysRoleId('procurement_manager') },
    { workflowId: wf.id, stepOrder: 3, stepName: 'Исп дир', stepKind: 'approval', approverRoleId: execRole.id },
    { workflowId: wf.id, stepOrder: 4, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await sysRoleId('requester') },
  ]);

  const user = async (roleIds: string[], tg: string): Promise<string> => {
    const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    for (const rid of roleIds) await db.insert(schema.userRoles).values({ userId: u.id, roleId: rid, holdingId: holding.id });
    return u.id;
  };
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, rateLimit: false });
  const login = async (tg: string): Promise<string> => (await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;
  return { db, app, holding, factory, wf, execRole, sysRoleId, user, login };
}

describe('getMoneyVisibility — единый гейт сумм', () => {
  it('денежные права видят всегда; согласующий после закупки — по маршруту; до закупки — нет', async () => {
    const { db, wf, execRole, sysRoleId, user } = await make();
    const snab = await user([await sysRoleId('procurement_manager')], 'snab');
    const exec = await user([execRole.id], 'exec');
    const dept = await user([await sysRoleId('dept_head')], 'dept');

    const mvSnab = await getMoneyVisibility(db, snab);
    expect(mvSnab.always).toBe(true);

    const mvExec = await getMoneyVisibility(db, exec);
    expect(mvExec.always).toBe(false);
    expect(mvExec.canSee({ workflowId: wf.id })).toBe(true); // шаг 3 ≥ закупка (шаг 2)

    const mvDept = await getMoneyVisibility(db, dept);
    expect(mvDept.canSee({ workflowId: wf.id })).toBe(false); // шаг 1 — до закупки
  });

  it('GET /requests/:id: «Исп дир» без денежных прав видит сумму и КП', async () => {
    const { db, app, holding, factory, execRole, sysRoleId, user, login } = await make();
    const requester = await user([await sysRoleId('requester')], 'req');
    await user([execRole.id], 'exec');
    const r = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    await db.insert(schema.quotations).values({ holdingId: holding.id, requestId: r.id, supplierName: 'ООО X', amount: 700, createdBy: requester });

    const tk = await login('exec');
    const res = await request(app).get(`/api/requests/${r.id}`).set('Authorization', `Bearer ${tk}`).expect(200);
    expect(res.body.canSeeMoney).toBe(true);
    expect(res.body.estimatedAmount).not.toBeNull();
    expect((res.body.quotations ?? []).length).toBe(1);
  });

  it('GET /requests/:id: рук. отдела (до закупки) сумму НЕ видит', async () => {
    const { db, app, holding, factory, sysRoleId, user, login } = await make();
    const requester = await user([await sysRoleId('requester')], 'req');
    await user([await sysRoleId('dept_head')], 'dept');
    const r = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    const tk = await login('dept');
    const res = await request(app).get(`/api/requests/${r.id}`).set('Authorization', `Bearer ${tk}`).expect(200);
    expect(res.body.canSeeMoney).toBe(false);
    expect(res.body.estimatedAmount).toBeNull();
  });
});
