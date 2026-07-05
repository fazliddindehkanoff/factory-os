/**
 * Ветка «Если отклонил» (workflow_steps.on_reject):
 *  - cancel (по умолчанию): отклонение терминально — как раньше;
 *  - return_requester: заявка уходит автору «на доработку» (needs_revision),
 *    автор — и только автор — отправляет её повторно (resubmit), маршрут
 *    прокладывается заново с первого применимого шага;
 *  - return_step: заявка возвращается на более ранний применимый шаг; кривая
 *    настройка (шаг не существует / не раньше текущего) откатывается к cancel.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { availableActions, performAction } from './lifecycle.service.js';
import { hashPin } from '../auth/pin.js';

const PIN = '1234';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function mkUser(db: any, holdingId: string, roleCodes: string[], tg: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active', pinHash: hashPin(PIN) })
    .returning();
  for (const code of roleCodes) {
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId });
  }
  return u.id;
}
const acts = (list: { action: string }[]) => list.map((a) => a.action);
const reload = async (db: any, id: string) => {
  const [r] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
  return r;
};
async function org(db: any) {
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  return { h, f };
}

describe('on_reject = return_requester', () => {
  /** 1: согласование склада (✕ → на доработку) → 2: закрытие автором. */
  async function flow(db: any, h: any, f: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      {
        workflowId: wf.id,
        stepOrder: 1,
        stepName: 'Нач. склада',
        stepKind: 'approval',
        approverRoleId: await roleId(db, 'warehouse'),
        onReject: 'return_requester',
      },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }

  it('отклонение уводит в needs_revision; автор видит resubmit и возвращает заявку в маршрут', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const req = await flow(db, h, f, requester);

    await performAction(db, { requestId: req.id, action: 'reject', actor: { id: wh, holdingId: h.id }, comment: 'уточните количество' });
    let r = await reload(db, req.id);
    expect(r.status).toBe('needs_revision');
    expect(r.currentStepId).toBeNull();
    expect(r.closedAt).toBeNull(); // не терминально — заявка живая

    // resubmit виден только автору
    expect(acts(await availableActions(db, r, requester))).toEqual(['resubmit']);
    expect(acts(await availableActions(db, r, wh))).toEqual([]);

    await performAction(db, { requestId: req.id, action: 'resubmit', actor: { id: requester, holdingId: h.id } });
    r = await reload(db, req.id);
    expect(r.status).toBe('pending_approval');
    expect(r.currentStepId).not.toBeNull();

    // на повторном заходе у шага есть НОВЫЙ pending-approval (старый остался rejected)
    const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.requestId, req.id));
    expect(rows.filter((a: any) => a.status === 'pending').length).toBe(1);
    expect(rows.filter((a: any) => a.status === 'rejected').length).toBe(1);
  });

  it('resubmit чужой заявки запрещён; в другом статусе — конфликт', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const req = await flow(db, h, f, requester);

    // ещё не на доработке
    await expect(
      performAction(db, { requestId: req.id, action: 'resubmit', actor: { id: requester, holdingId: h.id } }),
    ).rejects.toThrow(/не на доработке/);

    await performAction(db, { requestId: req.id, action: 'reject', actor: { id: wh, holdingId: h.id }, comment: 'нет' });
    await expect(
      performAction(db, { requestId: req.id, action: 'resubmit', actor: { id: wh, holdingId: h.id } }),
    ).rejects.toThrow(/только автор/);
  });
});

describe('on_reject = return_step', () => {
  /** 1: рук. отдела → 2: директор (✕ → вернуть на шаг 1). */
  async function flow(db: any, h: any, f: any, requesterId: string, targetOrder: number) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W2', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
      {
        workflowId: wf.id,
        stepOrder: 2,
        stepName: 'Директор',
        stepKind: 'approval',
        approverRoleId: await roleId(db, 'director'),
        onReject: 'return_step',
        onRejectStepOrder: targetOrder,
      },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }

  it('отклонение директора возвращает заявку на шаг 1 с новым pending-approval', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const head = await mkUser(db, h.id, ['dept_head'], 'head');
    const dir = await mkUser(db, h.id, ['director'], 'dir');
    const req = await flow(db, h, f, requester, 1);

    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: head, holdingId: h.id }, pin: PIN });
    await performAction(db, { requestId: req.id, action: 'reject', actor: { id: dir, holdingId: h.id }, comment: 'пересогласуйте' });

    const r = await reload(db, req.id);
    expect(r.status).toBe('pending_approval');
    const [cur] = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, r.currentStepId));
    expect(cur.stepOrder).toBe(1);

    // шаг 1 снова ждёт руководителя отдела
    expect(acts(await availableActions(db, r, head))).toContain('approve');
    const rows = await db.select().from(schema.approvals).where(eq(schema.approvals.requestId, req.id));
    expect(rows.filter((a: any) => a.status === 'pending').length).toBe(1);
  });

  it('кривая настройка (несуществующий шаг) откатывается к cancel', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const head = await mkUser(db, h.id, ['dept_head'], 'head');
    const dir = await mkUser(db, h.id, ['director'], 'dir');
    const req = await flow(db, h, f, requester, 7); // шага 7 нет

    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: head, holdingId: h.id }, pin: PIN });
    await performAction(db, { requestId: req.id, action: 'reject', actor: { id: dir, holdingId: h.id }, comment: 'нет' });

    const r = await reload(db, req.id);
    expect(r.status).toBe('rejected');
    expect(r.closedAt).not.toBeNull();
  });
});

describe('on_reject по умолчанию (cancel)', () => {
  it('отклонение без настройки терминально, как раньше', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W3', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Склад', stepKind: 'approval', approverRoleId: await roleId(db, 'warehouse') },
    ]);
    const req = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    await performAction(db, { requestId: req.id, action: 'reject', actor: { id: wh, holdingId: h.id }, comment: 'нет' });
    const r = await reload(db, req.id);
    expect(r.status).toBe('rejected');
    expect(acts(await availableActions(db, r, requester))).toEqual([]); // resubmit только из needs_revision
  });
});
