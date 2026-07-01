/**
 * M12 — a request created in a holding with no active workflow must be held as a
 * DRAFT, not silently auto-approved.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';

describe('request.service — M12 no-workflow guard', () => {
  it('a request with no active workflow is held as draft (not auto-approved)', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    await seedSystemRolesAndPermissions(db);
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const [u] = await db.insert(schema.users).values({ holdingId: h.id, fullName: 'R', telegramId: 'r', status: 'active' }).returning();
    // No workflow is created for this holding.
    const req = await createRequest(db, { holdingId: h.id, requesterId: u.id, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
    expect(req.status).toBe('draft');
    expect(req.currentStepId).toBeNull();
  });
});
