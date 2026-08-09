/**
 * QA 2026-07-09, «выбор отдела при создании заявки» (чат «Снабжение», 27.06):
 * заявка, адресованная отделу, должна попадать к руководителю ИМЕННО этого
 * отдела. Назначение роли со скоупом отдела — единый гейт для всех трёх слоёв:
 *  - stepActorIds (мгновенные уведомления / эскалации / дайджест);
 *  - getRequestVisibility (списки и карточка);
 *  - availableActions (кнопки действий).
 * Назначение БЕЗ скоупа по-прежнему покрывает весь холдинг.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { stepActorIds } from './step-actors.js';
import { availableActions } from './lifecycle.service.js';
import { getRequestVisibility } from '../http/request-visibility.js';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const [deptA] = await db.insert(schema.departments).values({ holdingId: holding.id, name: 'Отдел А' }).returning();
  const [deptB] = await db.insert(schema.departments).values({ holdingId: holding.id, name: 'Отдел Б' }).returning();
  return { db, holding, factory, deptA, deptB };
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function user(db: any, holding: any, tg: string, roleCode: string, departmentId?: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' })
    .returning();
  await db.insert(schema.userRoles).values({
    userId: u.id,
    roleId: await roleId(db, roleCode),
    holdingId: holding.id,
    ...(departmentId ? { departmentId } : {}),
  });
  return u.id;
}

async function flow(db: any, holding: any, factory: any, requesterId: string, departmentId: string) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Dept', isActive: true }).returning();
  const [step] = await db
    .insert(schema.workflowSteps)
    .values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ])
    .returning();
  const req = await createRequest(db, {
    holdingId: holding.id,
    requesterId,
    factoryId: factory.id,
    departmentId,
    items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
  });
  const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
  return { row, step };
}

describe('скоуп отдела маршрутизирует заявку к руководителю своего отдела', () => {
  it('уведомления шага получает только руководитель отдела заявки', async () => {
    const { db, holding, factory, deptA, deptB } = await make();
    const requester = await user(db, holding, 'req', 'requester');
    const headA = await user(db, holding, 'headA', 'dept_head', deptA.id);
    const headB = await user(db, holding, 'headB', 'dept_head', deptB.id);
    const { row, step } = await flow(db, holding, factory, requester, deptA.id);

    const actors = await stepActorIds(db, row, step);
    expect(actors).toContain(headA);
    expect(actors).not.toContain(headB);
  });

  it('видимость и действия: чужой отдел не видит и не может действовать, свой — может', async () => {
    const { db, holding, factory, deptA, deptB } = await make();
    const requester = await user(db, holding, 'req', 'requester');
    const headA = await user(db, holding, 'headA', 'dept_head', deptA.id);
    const headB = await user(db, holding, 'headB', 'dept_head', deptB.id);
    const { row } = await flow(db, holding, factory, requester, deptA.id);

    const visA = await getRequestVisibility(db, headA);
    const visB = await getRequestVisibility(db, headB);
    expect(visA.canSee(row)).toBe(true);
    expect(visB.canSee(row)).toBe(false);

    const actionsA = await availableActions(db, row, headA);
    const actionsB = await availableActions(db, row, headB);
    expect(actionsA.map((a: { action: string }) => a.action)).toContain('approve');
    expect(actionsB.length).toBe(0);
  });

  it('глобальная роль руководителя действует только в его назначенных отделах', async () => {
    const { db, holding, factory, deptA, deptB } = await make();
    const requester = await user(db, holding, 'req', 'requester');
    const headA = await user(db, holding, 'headA-global-role', 'dept_head');
    await db.insert(schema.userDepartments).values({ userId: headA, departmentId: deptA.id });
    const inA = await flow(db, holding, factory, requester, deptA.id);
    const [rowB] = await db.insert(schema.requests).values({
      holdingId: holding.id,
      requesterId: requester,
      workflowId: inA.row.workflowId,
      currentStepId: inA.step.id,
      departmentId: deptB.id,
      requestNumber: 'REQ-DEPT-B',
      status: 'pending_approval',
    }).returning();

    expect(await stepActorIds(db, inA.row, inA.step)).toContain(headA);
    expect(await stepActorIds(db, rowB, inA.step)).not.toContain(headA);
    const visibility = await getRequestVisibility(db, headA);
    expect(visibility.canSee(inA.row)).toBe(true);
    expect(visibility.canSee(rowB)).toBe(false);
    expect((await availableActions(db, inA.row, headA)).map((a: { action: string }) => a.action)).toContain('approve');
    expect(await availableActions(db, rowB, headA)).toEqual([]);
  });

  it('складской шаг и уведомление получает только ответственный выбранного склада', async () => {
    const { db, holding } = await make();
    const requester = await user(db, holding, 'warehouse-req', 'requester');
    const responsible = await user(db, holding, 'warehouse-owner', 'warehouse');
    const otherWarehouseUser = await user(db, holding, 'warehouse-other', 'warehouse');
    const [warehouse] = await db.insert(schema.warehouses).values({ holdingId: holding.id, name: 'Target warehouse' }).returning();
    await db.insert(schema.warehouseResponsibles).values({ warehouseId: warehouse.id, holdingId: holding.id, userId: responsible });
    const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Warehouse route', isActive: true }).returning();
    const [step] = await db.insert(schema.workflowSteps).values({
      workflowId: wf.id, stepOrder: 1, stepName: 'Warehouse check', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse'),
    }).returning();
    const req = await createRequest(db, {
      holdingId: holding.id, requesterId: requester, warehouseId: warehouse.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 1 }],
    });
    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(await stepActorIds(db, row, step)).toEqual([responsible]);
    expect((await availableActions(db, row, responsible)).length).toBeGreaterThan(0);
    expect(await availableActions(db, row, otherWarehouseUser)).toEqual([]);
  });
});
