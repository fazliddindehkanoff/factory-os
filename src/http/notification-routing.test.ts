/**
 * Аудит уведомлений 2026-07-07 — адресаты и триггеры:
 *  1. «Требуется действие» уходит при смене шага, not for stale repeated actions;
 *  2. procurement-шаг с назначенным исполнителем → уведомляется только он;
 *  3. close-шаг → «Подтвердите получение» уходит АВТОРУ, а не роли шага;
 *  4. автор не получает уведомлений о своих же действиях;
 *  5. reject с политикой return_step → автору «возвращена на этап», а не «согласована».
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from '../services/request.service.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make(opts: { onRejectStep2?: { onReject: string; onRejectStepOrder?: number } } = {}) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  // Без PIN — упрощает прогон действий (№15).
  await db.insert(schema.settings).values({ holdingId: holding.id, key: 'require_pin', value: '0' });

  const roleId = async (code: string): Promise<string> => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id;
  };
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'РОС', stepKind: 'approval', approverRoleId: await roleId('procurement_head') },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId('procurement_manager') },
    { workflowId: wf.id, stepOrder: 3, stepName: 'Снабжение — менеджер', stepKind: 'price_approval', approverRoleId: await roleId('procurement_head') },
    { workflowId: wf.id, stepOrder: 4, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId('director'), ...(opts.onRejectStep2 ? { onReject: opts.onRejectStep2.onReject, onRejectStepOrder: opts.onRejectStep2.onRejectStepOrder } : {}) },
    { workflowId: wf.id, stepOrder: 5, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId('requester') },
  ]);

  const user = async (codes: string[], tg: string): Promise<string> => {
    const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    for (const c of codes) await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(c), holdingId: holding.id });
    return u.id;
  };
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true });
  const login = async (tg: string): Promise<string> => (await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;
  const act = async (tg: string, id: string, action: string, extra: Record<string, unknown> = {}) => {
    const tk = await login(tg);
    const res = await request(app).post(`/api/requests/${id}/action`).set('Authorization', `Bearer ${tk}`).send({ action, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const notifsFor = async (userId: string) =>
    db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId, userId));
  return { db, app, holding, factory, wf, user, login, act, notifsFor };
}

describe('уведомления — адресаты и триггеры', () => {
  it('proposal approval routes to the next actor; close notification goes to the author', async () => {
    const { db, holding, factory, user, act, notifsFor } = await make();
    const requester = await user(['requester'], 'author');
    const ph = await user(['procurement_head'], 'ph');
    const snab1 = await user(['procurement_manager'], 'snab1');
    const snab2 = await user(['procurement_manager'], 'snab2');
    await user(['director'], 'dir');

    const r = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });

    // Шаг 1 → 2: передача назначенному снабженцу.
    await act('ph', r.id, 'assign_procurement', { assigneeId: snab1 });
    expect((await notifsFor(snab1)).filter((n: any) => n.kind === 'step_pending')).toHaveLength(1);
    // Второй снабженец заперт назначением — его не дёргаем.
    expect(await notifsFor(snab2)).toHaveLength(0);

    // Предложение двигает заявку на этап «Снабжение — менеджер» для руководителя снабжения.
    await act('snab1', r.id, 'add_quotation', { amount: 700, supplierName: 'ООО X' });
    expect((await notifsFor(snab1)).filter((n: any) => n.kind === 'step_pending')).toHaveLength(1);
    expect(await notifsFor(snab2)).toHaveLength(0);

    // Одобрение предложения → шаг «Директор».
    await act('ph', r.id, 'approve_price');
    await act('dir', r.id, 'approve');

    // close-шаг: «Подтвердите получение» — АВТОРУ (kind step_pending), не роли шага.
    const authorNotifs = await notifsFor(requester);
    expect(authorNotifs.some((n: any) => n.kind === 'step_pending' && /Подтвердите получение/.test(n.title))).toBe(true);

    // Автор подтверждает сам → самоуведомления о закрытии нет.
    const before = (await notifsFor(requester)).length;
    await act('author', r.id, 'close');
    expect((await notifsFor(requester)).length).toBe(before);
  });

  it('reject с return_step: автору приходит «возвращена на этап», а не «согласована»', async () => {
    const { db, holding, factory, user, act, notifsFor } = await make({ onRejectStep2: { onReject: 'return_step', onRejectStepOrder: 2 } });
    const requester = await user(['requester'], 'author');
    await user(['procurement_head'], 'ph');
    const snab1 = await user(['procurement_manager'], 'snab1');
    await user(['director'], 'dir');

    const r = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });
    await act('ph', r.id, 'assign_procurement', { assigneeId: snab1 });
    await act('snab1', r.id, 'add_quotation', { amount: 700, supplierName: 'ООО X' });
    await act('ph', r.id, 'approve_price');

    const stagePassedBefore = (await notifsFor(requester)).filter((n: any) => n.kind === 'stage_passed').length;
    await act('dir', r.id, 'reject', { comment: 'дорого, ищите дешевле' });
    const authorNotifs = await notifsFor(requester);
    expect(authorNotifs.some((n: any) => n.kind === 'returned_step')).toBe(true);
    // Возврат НЕ маскируется под «этап пройден/согласована».
    expect(authorNotifs.filter((n: any) => n.kind === 'stage_passed').length).toBe(stagePassedBefore);
    expect(authorNotifs.some((n: any) => n.kind === 'approved_final')).toBe(false);
  });
});
