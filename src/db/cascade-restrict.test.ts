/**
 * P1-8: business history must never be cascade-deleted with a request.
 * These FKs are RESTRICT, so a hard DELETE of a request that still has history
 * fails loudly. Accountability records survive; requests are archived, not deleted.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import * as schema from './schema.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });

  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: 'U', status: 'active' })
    .returning();
  const [req] = await db
    .insert(schema.requests)
    .values({ requestNumber: 'R-1', holdingId: holding.id, requesterId: user.id, status: 'pending_approval' })
    .returning();
  return { db, holding, user, req };
}

describe('P1-8: request history is RESTRICT, not cascade', () => {
  it('blocks hard-deleting a request that has status history', async () => {
    const { db, req, user } = await setup();
    await db.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      newStatus: 'pending_approval',
      changedBy: user.id,
    });

    await expect(
      db.delete(schema.requests).where(eq(schema.requests.id, req.id)),
    ).rejects.toThrow();

    // The request row is still there — nothing was silently erased.
    const rows = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(rows).toHaveLength(1);
  });

  it('blocks hard-deleting a request that has an approval', async () => {
    const { db, req } = await setup();
    await db.insert(schema.approvals).values({ requestId: req.id, status: 'pending' });

    await expect(
      db.delete(schema.requests).where(eq(schema.requests.id, req.id)),
    ).rejects.toThrow();
  });

  it('blocks deleting an approval that has a signature', async () => {
    const { db, req, user } = await setup();
    const [ap] = await db
      .insert(schema.approvals)
      .values({ requestId: req.id, status: 'approved' })
      .returning();
    await db.insert(schema.signatures).values({
      approvalId: ap.id,
      requestId: req.id,
      userId: user.id,
      signatureType: 'telegram_pin',
    });

    await expect(
      db.delete(schema.approvals).where(eq(schema.approvals.id, ap.id)),
    ).rejects.toThrow();
  });

  it('allows archiving a request (status change) — the intended path', async () => {
    const { db, req, user } = await setup();
    await db.insert(schema.requestStatusHistory).values({
      requestId: req.id,
      newStatus: 'pending_approval',
      changedBy: user.id,
    });
    await db.update(schema.requests).set({ status: 'archived' }).where(eq(schema.requests.id, req.id));
    const [row] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(row.status).toBe('archived');
  });
});
