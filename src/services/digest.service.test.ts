/**
 * Дайджест уведомлений (2026-07-07):
 *  - при notification_digest > 0 «Ждёт вас» пишется in-app БЕЗ TG-пуша;
 *  - runDigests шлёт одну TG-сводку с реальным числом ждущих заявок;
 *  - пока интервал не вышел или нет новых «Ждёт вас» — повторной сводки нет;
 *  - при выключенной настройке дайджест молчит, а мгновенный пуш уходит как обычно.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { runDigests } from './digest.service.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function setup(digestMinutes: number | null) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  await db.insert(schema.settings).values({ holdingId: h.id, key: 'require_pin', value: '0' });
  if (digestMinutes != null) {
    await db.insert(schema.settings).values({ holdingId: h.id, key: 'notification_digest', value: String(digestMinutes) });
  }
  const roleId = async (code: string): Promise<string> => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id;
  };
  const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId('director') },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId('requester') },
  ]);
  const user = async (code: string, tg: string): Promise<string> => {
    const [u] = await db.insert(schema.users).values({ holdingId: h.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(code), holdingId: h.id });
    return u.id;
  };
  const pushes: Array<[string, string]> = [];
  const deliver = async (tg: string, text: string) => { pushes.push([tg, text]); };
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true, notify: deliver });
  return { db, h, f, user, app, pushes, deliver };
}

describe('дайджест уведомлений', () => {
  it('digest on: step_pending без TG-пуша; сводка одна, повторно не шлётся без новых событий', async () => {
    const { db, h, f, user, pushes, deliver } = await setup(60);
    const requester = await user('requester', 'author');
    const dir = await user('director', 'dir');

    await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'A', quantity: 1, unitPrice: 5 }] });
    await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'B', quantity: 1, unitPrice: 5 }] });
    // Заявки создаются напрямую сервисом — руками шлём «Ждёт вас», как это
    // делает POST /requests (через notifyStepApprovers с подавленным пушем).
    // Здесь проверяем сам digest-сервис: создадим step_pending in-app строки.
    const { notifyUser } = await import('./notification.service.js');
    await notifyUser(db, undefined, { holdingId: h.id, recipientUserId: dir, title: 'Требуется действие — REQ-1', message: 'x', kind: 'step_pending' });
    await notifyUser(db, undefined, { holdingId: h.id, recipientUserId: dir, title: 'Требуется действие — REQ-2', message: 'x', kind: 'step_pending' });
    expect(pushes).toHaveLength(0); // TG молчал

    const t0 = new Date();
    const res = await runDigests(db, deliver, { now: t0 });
    expect(res.digestsSent).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0][0]).toBe('dir');
    expect(pushes[0][1]).toMatch(/Ждут вашего решения: 2/);

    // Без новых step_pending повторной сводки нет — даже когда интервал вышел.
    const res2 = await runDigests(db, deliver, { now: new Date(t0.getTime() + 2 * 3_600_000) });
    expect(res2.digestsSent).toBe(0);

    // Новое «Ждёт вас», но интервал с прошлой сводки НЕ вышел → тишина.
    await notifyUser(db, undefined, { holdingId: h.id, recipientUserId: dir, title: 'Требуется действие — REQ-3', message: 'x', kind: 'step_pending' });
    const res3 = await runDigests(db, deliver, { now: new Date(t0.getTime() + 10 * 60_000) });
    expect(res3.digestsSent).toBe(0);
  });

  it('digest off: мгновенный TG-пуш согласующему уходит при создании заявки', async () => {
    const { app, user, pushes } = await setup(null);
    await user('requester', 'author');
    await user('director', 'dir');
    const tk = (await request(app).post('/api/auth/dev').send({ telegramId: 'author' }).expect(200)).body.token as string;
    const res = await request(app)
      .post('/api/requests')
      .set('Authorization', `Bearer ${tk}`)
      .send({ items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });
    expect(res.status).toBe(201);
    // notifyStepApprovers работает асинхронно после ответа — дожидаемся.
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes.some(([tg, text]) => tg === 'dir' && /ожидает вашего действия/.test(text))).toBe(true);
  });

  it('digest on: создание заявки через API не пушит в TG, но пишет in-app', async () => {
    const { db, app, user, pushes } = await setup(60);
    await user('requester', 'author');
    const dir = await user('director', 'dir');
    const tk = (await request(app).post('/api/auth/dev').send({ telegramId: 'author' }).expect(200)).body.token as string;
    await request(app).post('/api/requests').set('Authorization', `Bearer ${tk}`).send({ items: [{ name: 'X', quantity: 1, unitPrice: 5 }] }).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes).toHaveLength(0);
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId, dir));
    expect(rows.filter((n: any) => n.kind === 'step_pending' && n.channel === 'inapp')).toHaveLength(1);
  });
});
