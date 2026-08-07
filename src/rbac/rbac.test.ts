import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { hasPermission, getUserPermissionCodes, scopeCovers } from './rbac.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}

async function systemRoleId(db: any, code: string): Promise<string> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
}

describe('scopeCovers', () => {
  it('a null (broad) assignment scope covers any target', () => {
    expect(scopeCovers({}, { factoryId: 'F1' })).toBe(true);
    expect(scopeCovers({ holdingId: 'H' }, { holdingId: 'H', factoryId: 'F1' })).toBe(true);
  });

  it('a factory-restricted assignment covers only that factory', () => {
    expect(scopeCovers({ factoryId: 'F1' }, { factoryId: 'F1' })).toBe(true);
    expect(scopeCovers({ factoryId: 'F1' }, { factoryId: 'F2' })).toBe(false);
    expect(scopeCovers({ factoryId: 'F1' }, {})).toBe(false); // unspecified target → fail closed
  });
});

describe('RBAC seeding + enforcement', () => {
  it('seeds idempotently (no duplicate roles on re-run)', async () => {
    const db = await setup();
    await seedSystemRolesAndPermissions(db); // run a second time
    const perms = await db.select().from(schema.permissions);
    const roles = await db.select().from(schema.roles);
    expect(perms.length).toBe(28); // catalog size (+materials.manage — namenklatura edit rights)
    expect(roles.length).toBe(19); // system roles, no duplicates (+executive_director 2026-07-11)
  });

  it('grants a permission within scope and denies it outside scope', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f1] = await db
      .insert(schema.factories)
      .values({ holdingId: h.id, name: 'F1' })
      .returning();
    const [f2] = await db
      .insert(schema.factories)
      .values({ holdingId: h.id, name: 'F2' })
      .returning();
    const [u] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, fullName: 'WH', telegramId: 'wh1' })
      .returning();
    await db.insert(schema.userRoles).values({
      userId: u.id,
      roleId: await systemRoleId(db, 'warehouse'),
      holdingId: h.id,
      factoryId: f1.id,
    });

    expect(await hasPermission(db, u.id, 'warehouse.receive', { holdingId: h.id, factoryId: f1.id })).toBe(true);
    expect(await hasPermission(db, u.id, 'warehouse.receive', { holdingId: h.id, factoryId: f2.id })).toBe(false);
    expect(await hasPermission(db, u.id, 'finance.mark_paid', { holdingId: h.id, factoryId: f1.id })).toBe(false);
  });

  it('owner holds every permission', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [u] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, fullName: 'Owner', telegramId: 'o1' })
      .returning();
    await db
      .insert(schema.userRoles)
      .values({ userId: u.id, roleId: await systemRoleId(db, 'owner'), holdingId: h.id });

    expect(await hasPermission(db, u.id, 'finance.mark_paid', { holdingId: h.id })).toBe(true);
    expect(await hasPermission(db, u.id, 'settings.manage', { holdingId: h.id })).toBe(true);
    const codes = await getUserPermissionCodes(db, u.id);
    expect(codes.length).toBe(28);
  });

  it('denies everything for a user with no role assignment (default-deny)', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [u] = await db
      .insert(schema.users)
      .values({ holdingId: h.id, fullName: 'Nobody', telegramId: 'n1' })
      .returning();
    expect(await hasPermission(db, u.id, 'requests.view', { holdingId: h.id })).toBe(false);
    expect(await getUserPermissionCodes(db, u.id)).toEqual([]);
  });
});
