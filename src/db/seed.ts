/**
 * Idempotent seed of the global permission catalog and system roles.
 * Safe to run repeatedly (used by db:seed and by tests).
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { SYSTEM_ROLES } from '../rbac/system-roles.js';

type Db = any;

export async function seedSystemRolesAndPermissions(db: Db): Promise<void> {
  // 1. Permissions — code is unique, so a plain upsert-nothing is idempotent.
  await db
    .insert(schema.permissions)
    .values(PERMISSIONS)
    .onConflictDoNothing({ target: schema.permissions.code });

  const permRows = await db.select().from(schema.permissions);
  const permByCode = new Map<string, string>(
    permRows.map((r: { code: string; id: string }) => [r.code, r.id]),
  );

  // 2. System roles have holdingId = null; the (holding_id, code) unique index does
  //    not guard NULL holdings, so we check existence explicitly for idempotency.
  for (const r of SYSTEM_ROLES) {
    const existing = await db
      .select()
      .from(schema.roles)
      .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, r.code)));

    let roleId: string;
    if (existing.length > 0) {
      roleId = existing[0].id;
    } else {
      const inserted = await db
        .insert(schema.roles)
        .values({ code: r.code, name: r.name, isSystem: true })
        .returning();
      roleId = inserted[0].id;
    }

    const codes = r.permissions === 'all' ? PERMISSIONS.map((p) => p.code) : r.permissions;
    const mappings: { roleId: string; permissionId: string }[] = [];
    for (const code of codes) {
      const permissionId = permByCode.get(code);
      if (permissionId) mappings.push({ roleId, permissionId });
    }
    if (mappings.length > 0) {
      await db.insert(schema.rolePermissions).values(mappings).onConflictDoNothing();
    }
  }
}
