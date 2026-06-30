/**
 * H1 — the default tenant workflow must route an in-stock request straight to
 * issue (skipping procurement/finance_payment/delivery/receiving), so issue draws
 * from existing stock and the balance is not artificially netted to zero.
 * M3 — tenant:setup must not seed demo users unless explicitly asked.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { setupTenant } from './tenant-setup.js';
import { seedSystemRolesAndPermissions } from './seed.js';
import { applicableSteps } from '../workflow/engine.js';
import { createRequest } from '../services/request.service.js';
import { performAction } from '../services/lifecycle.service.js';

async function db() {
  const client = new PGlite();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: './drizzle' });
  return d;
}

describe('H1 — in-stock routing on the seeded tenant workflow', () => {
  it('in-stock skips procurement/finance_payment/delivery/receiving; out-of-stock includes them', async () => {
    const d = await db();
    const { workflow } = await setupTenant(d, { holdingName: 'Z' });
    const steps = await d.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, workflow.id));
    const stepLikes = steps.map((s: any) => ({
      id: s.id,
      stepOrder: s.stepOrder,
      conditionRule: s.conditionRule,
      thresholdAmount: s.thresholdAmount,
      enabled: s.enabled,
    }));
    const kindsFor = (inStock: boolean) =>
      applicableSteps(stepLikes, { amount: 100_000, inStock }).map((s) => steps.find((x: any) => x.id === s.id)!.stepKind);

    const inStock = kindsFor(true);
    expect(inStock).toContain('approval'); // dept_head sign-off still applies
    expect(inStock).toContain('warehouse_check');
    expect(inStock).toContain('issue');
    expect(inStock).toContain('close');
    expect(inStock).not.toContain('procurement');
    expect(inStock).not.toContain('finance_payment');
    expect(inStock).not.toContain('delivery');
    expect(inStock).not.toContain('receiving');

    const outOfStock = kindsFor(false);
    expect(outOfStock).toContain('procurement');
    expect(outOfStock).toContain('finance_payment');
    expect(outOfStock).toContain('receiving');
  });

  it('in-stock issue decrements existing stock once and records no receiving (income) movement', async () => {
    const d = await db();
    await seedSystemRolesAndPermissions(d);
    const [h] = await d.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await d.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const roleId = async (code: string) => {
      const [r] = await d.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
      return r.id as string;
    };
    const userWith = async (code: string, tg: string) => {
      const [u] = await d.insert(schema.users).values({ holdingId: h.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
      await d.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(code), holdingId: h.id });
      return u.id;
    };
    const requester = await userWith('requester', 'r');
    const wh = await userWith('warehouse', 'w');

    // Workflow that mirrors the in-stock branch (no approvals/PIN to keep the test focused).
    const [wf] = await d.insert(schema.workflows).values({ holdingId: h.id, name: 'WF', isActive: true }).returning();
    await d.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId('warehouse') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Оплата', stepKind: 'finance_payment', approverRoleId: await roleId('finance'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Приёмка', stepKind: 'receiving', approverRoleId: await roleId('warehouse'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Выдача', stepKind: 'issue', approverRoleId: await roleId('warehouse') },
      { workflowId: wf.id, stepOrder: 5, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId('requester') },
    ]);
    const [mat] = await d.insert(schema.materials).values({ holdingId: h.id, name: 'Bolt', normalizedName: 'bolt', defaultUnit: 'шт' }).returning();
    await d.insert(schema.stockBalances).values({ holdingId: h.id, materialId: mat.id, availableQty: '100', minQty: '0' });

    const req = await createRequest(d, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'Bolt', materialId: mat.id, quantity: 5, unitPrice: 1000 }] });
    expect(req.status).toBe('warehouse_check');

    const afterCheck = await performAction(d, { requestId: req.id, action: 'wh_in_stock', actor: { id: wh, holdingId: h.id } });
    expect(afterCheck.status).toBe('issue'); // skipped finance_payment + receiving

    const afterIssue = await performAction(d, { requestId: req.id, action: 'issue', actor: { id: wh, holdingId: h.id } });
    expect(afterIssue.status).toBe('close');

    const moves = await d.select().from(schema.stockMovements).where(eq(schema.stockMovements.requestId, req.id));
    expect(moves.filter((m: any) => m.movementType === 'income').length).toBe(0); // no phantom receiving
    expect(moves.filter((m: any) => m.movementType === 'outcome').length).toBe(1); // issued exactly once
    const [bal] = await d.select().from(schema.stockBalances).where(eq(schema.stockBalances.materialId, mat.id));
    expect(Number(bal.availableQty)).toBe(95); // 100 → 95, drawn from existing stock
  });
});

describe('M3 — tenant:setup demo-user guard', () => {
  it('does NOT seed demo users by default (production-safe)', async () => {
    const d = await db();
    await setupTenant(d, { holdingName: 'Z', ownerTelegramId: '8236045489', ownerName: 'Owner' });
    const users = await d.select().from(schema.users);
    expect(users.some((u: any) => (u.telegramId ?? '').startsWith('demo_'))).toBe(false);
    // owner is still created
    expect(users.some((u: any) => u.telegramId === '8236045489')).toBe(true);
  });

  it('seeds demo users only when explicitly requested', async () => {
    const d = await db();
    await setupTenant(d, { holdingName: 'Z', seedDemoUsers: true });
    const users = await d.select().from(schema.users);
    expect(users.some((u: any) => u.telegramId === 'demo_owner')).toBe(true);
  });
});
