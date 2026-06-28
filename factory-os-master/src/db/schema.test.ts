import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';

async function freshDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('platform foundation schema', () => {
  it('migrates cleanly and round-trips a tenant, user, role and permission', async () => {
    const db = await freshDb();

    const [holding] = await db
      .insert(schema.holdings)
      .values({ name: 'Zelal Group' })
      .returning();
    expect(holding.id).toBeTruthy();
    expect(holding.currency).toBe('UZS');

    const [company] = await db
      .insert(schema.companies)
      .values({ holdingId: holding.id, name: 'Zelal Textile LLC' })
      .returning();
    const [factory] = await db
      .insert(schema.factories)
      .values({ holdingId: holding.id, companyId: company.id, name: 'Main Factory' })
      .returning();

    const [user] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'Test User', telegramId: '111' })
      .returning();
    expect(user.status).toBe('pending'); // default enum

    const [role] = await db
      .insert(schema.roles)
      .values({ holdingId: holding.id, code: 'owner', name: 'Owner' })
      .returning();
    const [perm] = await db
      .insert(schema.permissions)
      .values({ code: 'requests.create', name: 'Create requests', module: 'requests' })
      .returning();

    await db.insert(schema.rolePermissions).values({ roleId: role.id, permissionId: perm.id });
    await db.insert(schema.userRoles).values({
      userId: user.id,
      roleId: role.id,
      holdingId: holding.id,
      factoryId: factory.id,
    });

    const assignments = await db
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, user.id));
    expect(assignments.length).toBe(1);
    expect(assignments[0].status).toBe('active');
  });

  it('enforces the unique telegram_id constraint', async () => {
    const db = await freshDb();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    await db.insert(schema.users).values({ holdingId: h.id, fullName: 'A', telegramId: 'dup' });
    await expect(
      db.insert(schema.users).values({ holdingId: h.id, fullName: 'B', telegramId: 'dup' }),
    ).rejects.toThrow();
  });

  it('supports the request → approval domain and enforces one pending approval per request', async () => {
    const db = await freshDb();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [u] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, fullName: 'Requester', telegramId: 'req1' })
      .returning();
    const [wf] = await db
      .insert(schema.workflows)
      .values({ holdingId: h.id, name: 'Default request flow' })
      .returning();
    const [step] = await db
      .insert(schema.workflowSteps)
      .values({ workflowId: wf.id, stepOrder: 1, stepName: 'Dept head' })
      .returning();
    const [mat] = await db
      .insert(schema.materials)
      .values({ holdingId: h.id, name: 'Cotton yarn' })
      .returning();

    const [req] = await db
      .insert(schema.requests)
      .values({
        holdingId: h.id,
        requestNumber: 'REQ-2026-00001',
        requesterId: u.id,
        workflowId: wf.id,
        estimatedAmount: 7_800_000,
      })
      .returning();
    expect(req.priority).toBe('normal');
    expect(req.estimatedAmount).toBe(7_800_000); // bigint round-trips as number

    await db.insert(schema.requestItems).values({
      requestId: req.id,
      materialId: mat.id,
      name: 'Cotton yarn',
      quantity: '50',
      estimatedPrice: 156_000,
      totalAmount: 7_800_000,
    });
    await db.insert(schema.approvals).values({ requestId: req.id, workflowStepId: step.id });

    // A second PENDING approval for the same request must violate the partial unique index.
    await expect(
      db.insert(schema.approvals).values({ requestId: req.id, workflowStepId: step.id }),
    ).rejects.toThrow();
  });
});
