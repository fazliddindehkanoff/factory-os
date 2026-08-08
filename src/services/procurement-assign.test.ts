/**
 * Bug #8: the procurement head assigns a request to a specific снабженец. Only that
 * person then works the procurement step and approves the single proposal.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { performAction, availableActions } from './lifecycle.service.js';
import { hashPin } from '../auth/pin.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  const rid = async (c: string) => (await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, c))))[0].id as string;
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'WF', isActive: true }).returning();
  // step1: procurement head approval → step2: proposal → step3: manager approval
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 1, stepName: 'Нач. снабжения', stepKind: 'approval', approverRoleId: await rid('procurement_head') });
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 2, stepName: 'Снабжение', stepKind: 'procurement', approverRoleId: await rid('procurement_manager') });
  await db.insert(schema.workflowSteps).values({ workflowId: wf.id, stepOrder: 3, stepName: 'Снабжение — менеджер', stepKind: 'price_approval', approverRoleId: await rid('procurement_head') });
  const mk = async (tg: string, code: string, pin = true) => {
    const [u] = await db.insert(schema.users).values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active', pinHash: pin ? hashPin('1234') : null }).returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await rid(code), holdingId: holding.id });
    return u.id as string;
  };
  return { db, holding, factory, mk };
}

describe('bug #8: assign to a specific procurement person', () => {
  it('head assigns → responsibleUserId set, advances to procurement, only assignee works it', async () => {
    const { db, holding, factory, mk } = await setup();
    const head = await mk('head', 'procurement_head');
    const proc1 = await mk('proc1', 'procurement_manager');
    const proc2 = await mk('proc2', 'procurement_manager');
    const requester = await mk('req', 'requester', false);
    const created = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });

    // At step1 the head should see the "assign" action (next step is procurement).
    let [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.id));
    const headActions = await availableActions(db, req, head);
    expect(headActions.some((a) => a.action === 'assign_procurement')).toBe(true);

    // Head assigns proc1.
    await performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: proc1 });

    [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(req.responsibleUserId).toBe(proc1);
    expect(req.status).toBe('procurement');

    // Only proc1 can work the procurement step; proc2 is locked out.
    expect((await availableActions(db, req, proc1)).map((a) => a.action)).toEqual(['add_quotation']);
    expect((await availableActions(db, req, proc2)).length).toBe(0);
  });

  it('assigning a user without procurement rights is rejected', async () => {
    const { db, holding, factory, mk } = await setup();
    const head = await mk('head', 'procurement_head');
    const requester = await mk('req', 'requester', false);
    const created = await createRequest(db, { holdingId: holding.id, requesterId: requester, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    const [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.id));
    await expect(
      performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: requester }),
    ).rejects.toThrow();
  });

  it('procurement quote prices every product and stores calculated total with terms', async () => {
    const { db, holding, factory, mk } = await setup();
    const head = await mk('head', 'procurement_head');
    const proc = await mk('proc', 'procurement_manager');
    const requester = await mk('req', 'requester', false);
    const created = await createRequest(db, {
      holdingId: holding.id,
      requesterId: requester,
      factoryId: factory.id,
      items: [
        { name: 'A', quantity: 2, unitPrice: 0 },
        { name: 'B', quantity: 3, unitPrice: 0 },
      ],
    });
    let [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.id));
    await performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: proc });

    const items = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    await performAction(db, {
      requestId: req.id,
      action: 'add_quotation',
      actor: { id: proc, holdingId: holding.id },
      supplierName: 'Supplier',
      supplierPhone: '+998 90 123 45 67',
      ndsIncluded: true,
      quoteItems: [
        { itemId: items.find((i: any) => i.name === 'A')!.id, unitPrice: 100, supplierName: 'Supplier A', ndsIncluded: true, paymentType: 'Перечисление' },
        { itemId: items.find((i: any) => i.name === 'B')!.id, unitPrice: 50, supplierName: 'Supplier B', ndsIncluded: false, paymentType: 'Наличные' },
      ],
    });

    const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));
    expect(q.amount).toBe(350); // 2*100 + 3*50; NDS is metadata, not an auto multiplier
    expect(q.ndsIncluded).toBe(true);
    expect(q.paymentType).toBe('Перечисление');
    const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.normalizedPhone, '998901234567'));
    expect(q.supplierId).toBe(supplier.id);
    const [afterProposal] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(afterProposal.status).toBe('price_approval');
    expect(await availableActions(db, afterProposal, proc)).toEqual([]);
    // FIXES 2026-07-20: на проверке цены руководитель снабжения также выбирает КП
    // и может отклонить закупку (reject_purchase вернулся в действия шага).
    expect((await availableActions(db, afterProposal, head)).map((a) => a.action)).toEqual(['approve_price', 'select_supplier', 'reject_purchase']);
    const priced = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    expect(priced.find((i: any) => i.name === 'A')!.estimatedPrice).toBe(100);
    expect(priced.find((i: any) => i.name === 'A')!.totalAmount).toBe(200);
    expect(priced.find((i: any) => i.name === 'A')!.supplierName).toBe('Supplier');
    expect(priced.find((i: any) => i.name === 'A')!.ndsIncluded).toBe(true);
    expect(priced.find((i: any) => i.name === 'A')!.paymentType).toBe('Перечисление');
    expect(priced.find((i: any) => i.name === 'B')!.estimatedPrice).toBe(50);
    expect(priced.find((i: any) => i.name === 'B')!.totalAmount).toBe(150);
    expect(priced.find((i: any) => i.name === 'B')!.supplierName).toBe('Supplier');
    expect(priced.find((i: any) => i.name === 'B')!.ndsIncluded).toBe(false);
    expect(priced.find((i: any) => i.name === 'B')!.paymentType).toBe('Наличные');

    const createdAgain = await createRequest(db, {
      holdingId: holding.id, requesterId: requester, factoryId: factory.id,
      items: [{ name: 'C', quantity: 1, unitPrice: 0 }],
    });
    await performAction(db, { requestId: createdAgain.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: proc });
    const [itemAgain] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, createdAgain.id));
    await performAction(db, {
      requestId: createdAgain.id, action: 'add_quotation', actor: { id: proc, holdingId: holding.id },
      supplierName: 'A typo must not duplicate', supplierPhone: '90 123-45-67',
      quoteItems: [{ itemId: itemAgain.id, unitPrice: 10, paymentType: 'Наличные' }],
    });
    const suppliers = await db.select().from(schema.suppliers).where(eq(schema.suppliers.holdingId, holding.id));
    expect(suppliers).toHaveLength(1);
    const [quoteAgain] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, createdAgain.id));
    expect(quoteAgain.supplierId).toBe(supplier.id);
    expect(quoteAgain.supplierName).toBe('Supplier');
  });

  it('procurement can add product prices without supplier yet', async () => {
    const { db, holding, factory, mk } = await setup();
    const head = await mk('head-no-supplier', 'procurement_head');
    const proc = await mk('proc-no-supplier', 'procurement_manager');
    const requester = await mk('req-no-supplier', 'requester', false);
    const created = await createRequest(db, {
      holdingId: holding.id,
      requesterId: requester,
      factoryId: factory.id,
      items: [{ name: 'A', quantity: 2, unitPrice: 0 }],
    });
    const [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, created.id));
    await performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: head, holdingId: holding.id }, pin: '1234', assigneeId: proc });

    const [item] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, req.id));
    await expect(performAction(db, {
      requestId: req.id,
      action: 'add_quotation',
      actor: { id: proc, holdingId: holding.id },
      quoteItems: [{ itemId: item.id, unitPrice: 100, paymentType: 'Перечисление' }],
    })).resolves.toBeTruthy();

    const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));
    expect(q.supplierName).toBe('Не указан');
    expect(q.amount).toBe(200);
    const [priced] = await db.select().from(schema.requestItems).where(eq(schema.requestItems.id, item.id));
    expect(priced.supplierName).toBeNull();
    expect(priced.totalAmount).toBe(200);
    expect(priced.paymentType).toBe('Перечисление');
  });
});
