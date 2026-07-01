/**
 * Reset tenant data: wipe all requests, demo users, custom roles.
 * Keeps: owner user (OWNER_TG_ID), system roles + their permissions, holding/factory/workflow structure.
 */
import 'dotenv/config';
import { eq, ne, isNotNull, inArray, and } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

const OWNER_TG_ID = process.env.OWNER_TG_ID ?? '8236045489';

async function main() {
  const { db } = createDb(process.env.DATABASE_URL!);
  console.log('🧹 Starting tenant reset...\n');

  await db.transaction(async (tx) => {

    // 1. Wipe all requests and related data (cascade order)
    const allRequests = await tx.select({ id: schema.requests.id }).from(schema.requests);
    const reqIds = allRequests.map(r => r.id);
    if (reqIds.length) {
      await tx.delete(schema.signatures).where(inArray(schema.signatures.requestId, reqIds));
      await tx.delete(schema.approvals).where(inArray(schema.approvals.requestId, reqIds));
      await tx.delete(schema.requestStatusHistory).where(inArray(schema.requestStatusHistory.requestId, reqIds));
      await tx.delete(schema.requestItems).where(inArray(schema.requestItems.requestId, reqIds));
      await tx.delete(schema.requests);
      console.log(`✅ Deleted ${reqIds.length} requests (+ items, approvals, history, signatures)`);
    } else {
      console.log('✅ No requests to delete');
    }

    // 2. Wipe stock movements and balances
    await tx.delete(schema.reservations);
    await tx.delete(schema.stockMovements);
    await tx.delete(schema.stockBalances);
    console.log('✅ Cleared warehouse stock data');

    // 3. Delete all users except owner, delete their roles
    const [owner] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.telegramId, OWNER_TG_ID));

    if (!owner) {
      throw new Error(`Owner with telegramId ${OWNER_TG_ID} not found!`);
    }

    const otherUsers = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(ne(schema.users.id, owner.id));

    const otherIds = otherUsers.map(u => u.id);
    if (otherIds.length) {
      await tx.delete(schema.userRoles).where(inArray(schema.userRoles.userId, otherIds));
      await tx.delete(schema.auditLogs).where(inArray(schema.auditLogs.userId, otherIds));
      await tx.delete(schema.users).where(inArray(schema.users.id, otherIds));
      console.log(`✅ Deleted ${otherIds.length} users (+ role assignments + audit logs)`);
    } else {
      console.log('✅ No other users to delete');
    }

    // 4. Delete custom roles (holdingId IS NOT NULL = tenant-specific)
    const customRoles = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(isNotNull(schema.roles.holdingId));

    const customRoleIds = customRoles.map(r => r.id);
    if (customRoleIds.length) {
      await tx.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, customRoleIds));
      await tx.delete(schema.rolePermissions).where(inArray(schema.rolePermissions.roleId, customRoleIds));
      await tx.delete(schema.roles).where(inArray(schema.roles.id, customRoleIds));
      console.log(`✅ Deleted ${customRoleIds.length} custom roles`);
    } else {
      console.log('✅ No custom roles to delete');
    }

    // 5. Keep owner's role assignments — verify owner has 'owner' system role
    const ownerRoles = await tx
      .select()
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, owner.id));

    console.log(`✅ Owner retains ${ownerRoles.length} role assignment(s)`);

    // 6. Clear remaining audit logs (owner's own logs — fresh start)
    await tx.delete(schema.auditLogs);
    console.log('✅ Cleared audit log (fresh start)');

  });

  console.log('\n✅ Reset complete. Owner:', OWNER_TG_ID);
  console.log('   System roles, permissions, holding, factory, workflows — all intact.');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Reset failed:', e);
  process.exit(1);
});
