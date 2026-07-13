/**
 * Полный 11-шаговый воркфлоу с действиями по каждому продукту:
 *  - #3 «Частично в наличии» дробит заявку (split): in-stock → выдача, out-of-stock
 *    → новая связанная заявка в закупку;
 *  - #5 procurement_intake, #7 price_approval, #10 ordering (order_status),
 *    #11 приёмка по позициям (received_qty, расхождение).
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { performAction, markItemStock } from './lifecycle.service.js';
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
async function mkUser(db: any, holdingId: string, code: string, tg: string, withPin = false): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active', ...(withPin ? { pinHash: hashPin(PIN) } : {}) })
    .returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId });
  return u.id;
}

describe('#3 partial stock → order split', () => {
  it('mixed availability splits: in-stock item issued, out-of-stock item → new linked order in procurement', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [matA] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Болт' }).returning();
    const [matB] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Гайка' }).returning();
    await db.insert(schema.stockBalances).values({ holdingId: h.id, materialId: matA.id, availableQty: '100', minQty: '0' });

    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Split', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Выдача', stepKind: 'issue', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 5, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    const act = (id: string, action: string, actorId: string, extra: any = {}) =>
      performAction(db, { requestId: id, action, actor: { id: actorId, holdingId: h.id }, ...extra });

    const req = await createRequest(db, {
      holdingId: h.id, requesterId: requester, factoryId: f.id,
      items: [
        { name: 'Болт', materialId: matA.id, quantity: 5, unitPrice: 1000 },
        { name: 'Гайка', materialId: matB.id, quantity: 10, unitPrice: 500 },
      ],
    });
    await act(req.id, 'approve', dh, { pin: PIN });
    // Per-product: Болт есть, Гайка — нет.
    const items = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    const bolt = items.find((i: any) => i.name === 'Болт')!;
    const gaika = items.find((i: any) => i.name === 'Гайка')!;
    await markItemStock(db, { requestId: req.id, itemId: bolt.id, inStock: true, actor: { id: wh, holdingId: h.id } });
    await markItemStock(db, { requestId: req.id, itemId: gaika.id, inStock: false, actor: { id: wh, holdingId: h.id } });

    const afterPartial = await act(req.id, 'wh_partial', wh);
    // Parent keeps the in-stock item and heads to issue.
    expect(afterPartial.status).toBe('issue');
    const parentItems = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    expect(parentItems.length).toBe(1);
    expect(parentItems[0].name).toBe('Болт');
    expect(afterPartial.estimatedAmount).toBe(5000); // only Болт

    // A new linked order carries the out-of-stock item into procurement.
    const children = await db.select().from(schema.requests).where(eq(schema.requests.parentRequestId, req.id));
    expect(children.length).toBe(1);
    const child = children[0];
    expect(child.status).toBe('procurement');
    expect(child.inStock).toBe(false);
    expect(child.estimatedAmount).toBe(5000); // only Гайка (10×500)
    const childItems = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, child.id));
    expect(childItems.length).toBe(1);
    expect(childItems[0].name).toBe('Гайка');
    expect(childItems[0].status).toBe('out_of_stock');

    // Parent finishes: issue draws Болт, close.
    expect((await act(req.id, 'issue', wh)).status).toBe('close');
    expect((await act(req.id, 'close', requester)).status).toBe('closed');
    const [balA] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, matA.id));
    expect(Number(balA.availableQty)).toBe(95);
  });
});

describe('new step-kinds: intake → price approval → ordering → per-item receiving', () => {
  it('drives the procurement chain with order_status and partial receipt', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [mat] = await db.insert(schema.materials).values({ holdingId: h.id, name: 'Труба' }).returning();

    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'Proc', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Принятие', stepKind: 'procurement_intake', approverRoleId: await roleId(db, 'procurement_head') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Поиск', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement') },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Цена', stepKind: 'price_approval', approverRoleId: await roleId(db, 'procurement_head'), onReject: 'return_step', onRejectStepOrder: 3 },
      { workflowId: wf.id, stepOrder: 5, stepName: 'Заказ', stepKind: 'ordering', approverRoleId: await roleId(db, 'procurement') },
      { workflowId: wf.id, stepOrder: 6, stepName: 'Приёмка', stepKind: 'receiving', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 7, stepName: 'Выдача', stepKind: 'issue', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 8, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    const requester = await mkUser(db, h.id, 'requester', 'req');
    const dh = await mkUser(db, h.id, 'dept_head', 'dh', true);
    const phead = await mkUser(db, h.id, 'procurement_head', 'ph');
    const pman = await mkUser(db, h.id, 'procurement', 'pm');
    const wh = await mkUser(db, h.id, 'warehouse', 'wh');
    const act = (id: string, action: string, actorId: string, extra: any = {}) =>
      performAction(db, { requestId: id, action, actor: { id: actorId, holdingId: h.id }, ...extra });

    const req = await createRequest(db, {
      holdingId: h.id, requesterId: requester, factoryId: f.id,
      items: [{ name: 'Труба', materialId: mat.id, quantity: 10, unitPrice: 700 }],
    });
    expect((await act(req.id, 'approve', dh, { pin: PIN })).status).toBe('procurement_intake');
    // #5 руководитель снабжения: назначает снабженца → поиск.
    expect((await act(req.id, 'assign_procurement', phead, { assigneeId: pman })).status).toBe('procurement');
    // #6 назначенный снабженец: одно предложение сразу уходит на одобрение менеджеру.
    expect((await act(req.id, 'add_quotation', pman, { supplierName: 'ООО Металл', amount: 9000 })).status).toBe('price_approval');
    expect((await act(req.id, 'approve_price', phead)).status).toBe('ordering');
    // #10 менеджер: оформление и отправка (order_status), затем поставка → приёмка.
    expect((await act(req.id, 'place_order', pman)).orderStatus).toBe('ordered');
    expect((await act(req.id, 'mark_sent', pman)).orderStatus).toBe('sent');
    const delivered = await act(req.id, 'mark_delivered', pman);
    expect(delivered.orderStatus).toBe('delivered');
    expect(delivered.status).toBe('receiving');
    // #11 приёмка с расхождением: заказано 10, принято 8.
    const [item] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    expect((await act(req.id, 'receive_discrepancy', wh, { comment: 'недовоз 2', receipts: [{ itemId: item.id, receivedQty: 8 }] })).status).toBe('issue');
    const [afterRecv] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.id, item.id));
    expect(Number(afterRecv.receivedQty)).toBe(8);
    expect(afterRecv.status).toBe('short');
    // Income booked what actually arrived (8), issue draws the same 8 → balance 0.
    const [bal] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, mat.id));
    expect(Number(bal.availableQty)).toBe(8);
    expect((await act(req.id, 'issue', wh)).status).toBe('close');
    const [bal2] = await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, mat.id));
    expect(Number(bal2.availableQty)).toBe(0);
    expect((await act(req.id, 'close', requester)).status).toBe('closed');
  });
});
