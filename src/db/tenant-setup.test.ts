import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';
import { setupTenant } from './tenant-setup.js';
import { hasPermission } from '../rbac/rbac.js';
import { createRequest } from '../services/request.service.js';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('setupTenant', () => {
  it('creates holding/factory/workflow with 11 data-driven steps, idempotently', async () => {
    const db = await freshDb();
    const a = await setupTenant(db, { holdingName: 'Zelal' });
    const steps1 = await db
      .select()
      .from(schema.workflowSteps)
      .where(eq(schema.workflowSteps.workflowId, a.workflow.id));
    expect(steps1.length).toBe(11);

    // Re-run: no duplicate holdings / workflows / steps.
    const b = await setupTenant(db, { holdingName: 'Zelal' });
    expect(b.holding.id).toBe(a.holding.id);
    expect(b.workflow.id).toBe(a.workflow.id);
    const steps2 = await db
      .select()
      .from(schema.workflowSteps)
      .where(eq(schema.workflowSteps.workflowId, a.workflow.id));
    expect(steps2.length).toBe(11);
    const holdings = await db.select().from(schema.holdings);
    expect(holdings.length).toBe(1);
  });

  it('assigns the owner by Telegram id with full permissions', async () => {
    const db = await freshDb();
    const { holding, owner } = await setupTenant(db, {
      holdingName: 'Zelal',
      ownerTelegramId: '555',
      ownerName: 'Boss',
    });
    expect(owner?.telegramId).toBe('555');
    expect(await hasPermission(db, owner!.id, 'finance.mark_paid', { holdingId: holding.id })).toBe(
      true,
    );
    // Re-running does not create a duplicate owner assignment.
    await setupTenant(db, { holdingName: 'Zelal', ownerTelegramId: '555' });
    const assigns = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, owner!.id));
    expect(assigns.length).toBe(1);
  });

  it('produces a workflow that routes a new request to the first (dept_head) step', async () => {
    const db = await freshDb();
    const { holding, factory } = await setupTenant(db, { holdingName: 'Zelal' });
    const [requester] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'R', telegramId: 'r1' })
      .returning();
    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: requester.id,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 2, unitPrice: 1000 }],
    });
    expect(req.status).toBe('pending_approval');
    const pend = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.requestId, req.id));
    expect(pend.length).toBe(1);
  });
});
