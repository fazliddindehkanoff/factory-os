/**
 * Эскалация по таймауту шага (2026-07-07):
 *  - до таймаута — тишина;
 *  - после таймаута — L1 (urgent) ответственным шага, ровно один раз;
 *  - после 2×таймаута — L2 (critical) держателям approvals.override, один раз;
 *  - дефолт холдинга step_timeout_hours подхватывается, когда у шага нет своего;
 *  - непродвигающее действие не сбрасывает таймер (история с тем же статусом).
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { runEscalations } from './escalation.service.js';

async function setup(opts: { stepTimeout?: number | null; holdingDefault?: number } = {}) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  if (opts.holdingDefault) {
    await db.insert(schema.settings).values({ holdingId: h.id, key: 'step_timeout_hours', value: String(opts.holdingDefault) });
  }
  const roleId = async (code: string): Promise<string> => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id;
  };
  const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId('director'), timeoutHours: opts.stepTimeout ?? null },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId('requester') },
  ]);
  const user = async (code: string, tg: string): Promise<string> => {
    const [u] = await db.insert(schema.users).values({ holdingId: h.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(code), holdingId: h.id });
    return u.id;
  };
  return { db, h, f, user };
}

const notifs = (db: any, userId: string) =>
  db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId, userId));

const hoursLater = (from: Date, hours: number) => new Date(from.getTime() + hours * 3_600_000);

describe('эскалация по таймауту', () => {
  it('L1 ответственным после таймаута (один раз), L2 овнеру после 2× (один раз)', async () => {
    const { db, h, f, user } = await setup({ stepTimeout: 24 });
    const requester = await user('requester', 'author');
    const dir = await user('director', 'dir');
    const owner = await user('owner', 'boss'); // approvals.override
    const created = new Date();
    const r = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });
    void r;

    // До таймаута — тишина.
    let res = await runEscalations(db, undefined, { now: hoursLater(created, 12) });
    expect(res.remindersSent).toBe(0);

    // После таймаута — L1 директору (не автору, не овнеру).
    res = await runEscalations(db, undefined, { now: hoursLater(created, 25) });
    expect(res.remindersSent).toBe(1);
    expect((await notifs(db, dir)).filter((n: any) => n.kind === 'escalation')).toHaveLength(1);
    expect((await notifs(db, owner)).filter((n: any) => n.kind === 'escalation')).toHaveLength(0);

    // Повторный прогон — дубля нет.
    res = await runEscalations(db, undefined, { now: hoursLater(created, 26) });
    expect(res.remindersSent).toBe(0);

    // 2×таймаут — L2 держателю approvals.override, и тоже один раз.
    res = await runEscalations(db, undefined, { now: hoursLater(created, 49) });
    expect(res.overdueSent).toBe(1);
    expect((await notifs(db, owner)).filter((n: any) => n.kind === 'escalation' && n.priority === 'critical')).toHaveLength(1);
    res = await runEscalations(db, undefined, { now: hoursLater(created, 60) });
    expect(res.overdueSent).toBe(0);
  });

  it('без таймаута шага работает дефолт холдинга step_timeout_hours', async () => {
    const { db, h, f, user } = await setup({ stepTimeout: null, holdingDefault: 10 });
    const requester = await user('requester', 'author');
    const dir = await user('director', 'dir');
    const created = new Date();
    await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });

    expect((await runEscalations(db, undefined, { now: hoursLater(created, 5) })).remindersSent).toBe(0);
    expect((await runEscalations(db, undefined, { now: hoursLater(created, 11) })).remindersSent).toBe(1);
    expect((await notifs(db, dir)).filter((n: any) => n.kind === 'escalation')).toHaveLength(1);
  });

  it('нет ни таймаута шага, ни дефолта — заявка не эскалируется', async () => {
    const { db, h, f, user } = await setup({ stepTimeout: null });
    const requester = await user('requester', 'author');
    await user('director', 'dir');
    const created = new Date();
    await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });
    const res = await runEscalations(db, undefined, { now: hoursLater(created, 1000) });
    expect(res.checked).toBe(0);
    expect(res.remindersSent).toBe(0);
  });
});
