import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setupTenant } from '../db/tenant-setup.js';
import { createRequest } from './request.service.js';
import { getDashboard } from './dashboard.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const { holding, factory } = await setupTenant(db, { holdingName: 'Zelal', ownerTelegramId: '999' });
  const [requester] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: 'R', telegramId: 'r1' })
    .returning();
  return { db, holding, factory, requester };
}

describe('getDashboard', () => {
  it('counts the requester active requests and holding totals', async () => {
    const { db, holding, factory, requester } = await setup();
    await createRequest(db, {
      holdingId: holding.id,
      requesterId: requester.id,
      factoryId: factory.id,
      items: [{ name: 'X', quantity: 1, unitPrice: 1000 }],
    });

    const reqDash = await getDashboard(db, requester.id, holding.id);
    expect(reqDash.myActive).toBe(1);
    expect(reqDash.activity.length).toBe(1);

    const [owner] = await db.select().from(schema.users).where(eq(schema.users.telegramId, '999'));
    const ownerDash = await getDashboard(db, owner.id, holding.id);
    expect(ownerDash.totalActive).toBe(1); // the request is pending_approval (active)
  });

  it('returns zeros for a user with no holding', async () => {
    const { db } = await setup();
    const d = await getDashboard(db, '00000000-0000-0000-0000-000000000000', null);
    expect(d).toEqual({ myActive: 0, pendingForMe: 0, totalActive: 0, activity: [] });
  });
});
