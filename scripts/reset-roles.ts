/**
 * Wipe ALL roles and create a single "Администратор" role with all permissions.
 * Assigns it to the owner. After this, create roles from Admin Panel.
 */
import 'dotenv/config';
import { eq, isNull } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { assertWipeAllowed } from './_wipe-guard.js';

// No hardcoded production owner id: the caller must name the owner explicitly.
const OWNER_TG_ID = process.env.OWNER_TG_ID;

async function main() {
  assertWipeAllowed('reset-roles.ts');
  if (!OWNER_TG_ID) {
    throw new Error('OWNER_TG_ID env var is required (telegram id of the owner to keep).');
  }
  const { db } = createDb(process.env.DATABASE_URL!);
  console.log('🔄 Resetting roles...\n');

  await db.transaction(async (tx) => {

    // Find owner
    const [owner] = await tx.select().from(schema.users)
      .where(eq(schema.users.telegramId, OWNER_TG_ID));
    if (!owner) throw new Error(`Owner ${OWNER_TG_ID} not found`);

    // Find holding
    if (!owner.holdingId) throw new Error('Owner has no holdingId');

    // Get all permissions
    const permissions = await tx.select().from(schema.permissions);
    console.log(`Found ${permissions.length} permissions`);

    // 1. Delete all user_roles
    await tx.delete(schema.userRoles);
    console.log('✅ Cleared all user_roles');

    // 2. Delete all role_permissions
    await tx.delete(schema.rolePermissions);
    console.log('✅ Cleared all role_permissions');

    // 3. Detach roles from workflow steps (FK), then delete all roles
    await tx.update(schema.workflowSteps).set({ approverRoleId: null });
    await tx.delete(schema.roles);
    console.log('✅ Deleted all roles');

    // 4. Create single "Администратор" role scoped to holding
    const [adminRole] = await tx.insert(schema.roles).values({
      code: 'administrator',
      name: 'Администратор',
      holdingId: owner.holdingId,
      isSystem: false,
    }).returning();
    console.log(`✅ Created role: ${adminRole.name} (id: ${adminRole.id})`);

    // 5. Assign ALL permissions to this role
    await tx.insert(schema.rolePermissions).values(
      permissions.map(p => ({ roleId: adminRole.id, permissionId: p.id }))
    );
    console.log(`✅ Assigned all ${permissions.length} permissions to Администратор`);

    // 6. Assign this role to owner (holding scope)
    await tx.insert(schema.userRoles).values({
      userId: owner.id,
      roleId: adminRole.id,
      holdingId: owner.holdingId,
      status: 'active',
    });
    console.log(`✅ Assigned Администратор to owner (${OWNER_TG_ID})`);

  });

  console.log('\n✅ Done. Only one role exists: «Администратор» with all permissions.');
  console.log('   Now go to Admin Panel → Roles to create your company\'s role structure.');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Failed:', e.message);
  process.exit(1);
});
