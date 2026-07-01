/**
 * Deterministic pilot/demo seed — the golden path:
 *   requester creates → director approves (PIN) → warehouse checks → warehouse
 *   issues → requester closes.
 *
 * Idempotent (safe to re-run): looks up by stable names/telegram ids before
 * inserting. Roles are holding-scoped for the demo so every pilot user can act
 * across the single holding without per-department scope juggling.
 *
 * Demo PIN for the PIN-gated users (director, warehouse) is PILOT_PIN below.
 * Seed only — never run against production data.
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { seedSystemRolesAndPermissions } from './seed.js';
import { hashPin } from '../auth/pin.js';

type Db = any;

export const PILOT_PIN = '1234';

async function roleId(db: Db, code: string): Promise<string | undefined> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r?.id;
}

async function findOrInsert(db: Db, table: any, where: any, values: any) {
  const existing = await db.select().from(table).where(where);
  if (existing.length > 0) return existing[0];
  const [row] = await db.insert(table).values(values).returning();
  return row;
}

interface UserSpec {
  tg: string;
  name: string;
  role: 'requester' | 'director' | 'warehouse' | 'admin';
  pin: boolean;
}

const USER_SPECS: UserSpec[] = [
  { tg: 'pilot_requester', name: 'Demo Requester', role: 'requester', pin: true },
  { tg: 'pilot_director', name: 'Demo Director', role: 'director', pin: true },
  { tg: 'pilot_warehouse', name: 'Demo Warehouse', role: 'warehouse', pin: true },
  { tg: 'pilot_admin', name: 'Demo Admin', role: 'admin', pin: false },
];

// Golden pilot workflow on existing step-kinds — no reserve, no new statuses.
const STEP_SPECS = [
  { code: 'director', order: 1, name: 'Согласование директора', kind: 'approval' },
  { code: 'warehouse', order: 2, name: 'Проверка склада', kind: 'warehouse_check' },
  { code: 'warehouse', order: 3, name: 'Выдача со склада', kind: 'issue' },
  { code: 'requester', order: 4, name: 'Подтверждение получения', kind: 'close' },
];

export async function seedPilot(db: Db) {
  await seedSystemRolesAndPermissions(db);

  const holding = await findOrInsert(db, schema.holdings, eq(schema.holdings.name, 'Zelal Group'), {
    name: 'Zelal Group',
  });
  const company = await findOrInsert(
    db,
    schema.companies,
    and(eq(schema.companies.holdingId, holding.id), eq(schema.companies.name, 'Zelal Textile')),
    { holdingId: holding.id, name: 'Zelal Textile', legalName: 'Zelal Textile LLC' },
  );
  const factory = await findOrInsert(
    db,
    schema.factories,
    and(eq(schema.factories.holdingId, holding.id), eq(schema.factories.name, 'Zelal Textile Main Factory')),
    { holdingId: holding.id, companyId: company.id, name: 'Zelal Textile Main Factory' },
  );
  const deptProduction = await findOrInsert(
    db,
    schema.departments,
    and(eq(schema.departments.holdingId, holding.id), eq(schema.departments.name, 'Production')),
    { holdingId: holding.id, factoryId: factory.id, name: 'Production', type: 'production' },
  );
  const deptWarehouse = await findOrInsert(
    db,
    schema.departments,
    and(eq(schema.departments.holdingId, holding.id), eq(schema.departments.name, 'Warehouse')),
    { holdingId: holding.id, factoryId: factory.id, name: 'Warehouse', type: 'warehouse' },
  );
  const warehouse = await findOrInsert(
    db,
    schema.warehouses,
    and(eq(schema.warehouses.holdingId, holding.id), eq(schema.warehouses.name, 'Main Warehouse')),
    { holdingId: holding.id, factoryId: factory.id, name: 'Main Warehouse', type: 'main' },
  );

  const users: Record<string, any> = {};
  for (const s of USER_SPECS) {
    let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, s.tg));
    if (!u) {
      [u] = await db
        .insert(schema.users)
        .values({
          holdingId: holding.id,
          telegramId: s.tg,
          fullName: s.name,
          status: 'active',
          ...(s.pin ? { pinHash: hashPin(PILOT_PIN) } : {}),
        })
        .returning();
    }
    const rid = await roleId(db, s.role);
    const existing = await db
      .select()
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.roleId, rid as string)));
    if (existing.length === 0) {
      await db.insert(schema.userRoles).values({ userId: u.id, roleId: rid, holdingId: holding.id });
    }
    users[s.role] = u;
  }

  const matSpecs = [
    { key: 'inStock', name: 'Подшипник 6205', unit: 'шт', qty: '100', minQty: '10' },
    { key: 'lowStock', name: 'Ремень приводной A-100', unit: 'шт', qty: '1', minQty: '5' },
  ];
  const materials: Record<string, any> = {};
  for (const m of matSpecs) {
    const mat = await findOrInsert(
      db,
      schema.materials,
      and(eq(schema.materials.holdingId, holding.id), eq(schema.materials.name, m.name)),
      { holdingId: holding.id, name: m.name, normalizedName: m.name.toLowerCase(), defaultUnit: m.unit },
    );
    // Stock lives in the holding's default pool (warehouseId = null): the lifecycle
    // issue step is warehouse-agnostic and decrements THIS pool. The Main Warehouse
    // entity above is structural (org chart / admin demo). Tying issue to a specific
    // warehouse is a fast-follow, out of pilot scope.
    const [bal] = await db
      .select()
      .from(schema.stockBalances)
      .where(
        and(
          eq(schema.stockBalances.holdingId, holding.id),
          isNull(schema.stockBalances.warehouseId),
          eq(schema.stockBalances.materialId, mat.id),
        ),
      );
    if (!bal) {
      await db.insert(schema.stockBalances).values({
        holdingId: holding.id,
        materialId: mat.id,
        availableQty: m.qty,
        minQty: m.minQty,
      });
    }
    materials[m.key] = mat;
  }

  let [workflow] = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.holdingId, holding.id), eq(schema.workflows.name, 'Pilot Workflow')));
  if (!workflow) {
    [workflow] = await db
      .insert(schema.workflows)
      .values({ holdingId: holding.id, name: 'Pilot Workflow', isActive: true })
      .returning();
    for (const s of STEP_SPECS) {
      await db.insert(schema.workflowSteps).values({
        workflowId: workflow.id,
        stepOrder: s.order,
        stepName: s.name,
        stepKind: s.kind,
        approverRoleId: await roleId(db, s.code),
      });
    }
  }

  return { holding, company, factory, deptProduction, deptWarehouse, warehouse, workflow, users, materials, pin: PILOT_PIN };
}
