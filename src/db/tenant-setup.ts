/**
 * Idempotent tenant bootstrap: creates a holding, a factory, the default approval
 * workflow (the legacy tiered chain expressed as DATA), baseline settings, and
 * optionally assigns an owner by Telegram id. Safe to re-run.
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { seedSystemRolesAndPermissions } from './seed.js';
import { seedFormFields } from './seed-form-fields.js';

type Db = any;

const WORKFLOW_NAME = 'Стандартная цепочка согласования';

interface StepSpec {
  code: string;
  order: number;
  name: string;
  kind: string;
  condition?: Record<string, unknown>;
  threshold?: number;
}

// The whole path is data-driven: approvals (sign-off by role) interleave with the
// operational kinds (warehouse_check / procurement / finance_payment / delivery /
// receiving / issue / close), each carrying its own behaviour via stepKind.
// dept_head → склад → закупка(если нет в наличии) → финансы(≥5M) → директор(≥30M)
//   → учредитель(≥100M) → оплата → доставка → приёмка.
const STEP_SPECS: StepSpec[] = [
  { code: 'dept_head', order: 1, name: 'Рук. отдела', kind: 'approval' },
  { code: 'warehouse', order: 2, name: 'Проверка склада', kind: 'warehouse_check' },
  { code: 'procurement', order: 3, name: 'Снабжение', kind: 'procurement', condition: { inStock: false } },
  { code: 'procurement_head', order: 4, name: 'Снабжение — менеджер', kind: 'price_approval', condition: { inStock: false } },
  { code: 'finance', order: 5, name: 'Финансы', kind: 'approval', threshold: 5_000_000 },
  { code: 'director', order: 6, name: 'Директор', kind: 'approval', threshold: 30_000_000 },
  { code: 'owner', order: 7, name: 'Учредитель', kind: 'approval', threshold: 100_000_000 },
  // H1 fix: these apply only when the item is NOT in stock. An in-stock request goes
  // approval → warehouse_check → issue → close, and `issue` draws from existing stock —
  // no phantom payment/delivery/receiving (which previously netted the balance to zero).
  { code: 'finance', order: 8, name: 'Оплата', kind: 'finance_payment', condition: { inStock: false } },
  { code: 'procurement', order: 9, name: 'Доставка', kind: 'delivery', condition: { inStock: false } },
  { code: 'warehouse', order: 10, name: 'Приёмка на склад', kind: 'receiving', condition: { inStock: false } },
];

async function roleIdByCode(db: Db, code: string): Promise<string | undefined> {
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

export interface TenantSetupInput {
  holdingName: string;
  factoryName?: string;
  ownerTelegramId?: string;
  ownerName?: string;
  /** Seed 8 demo users (demo_owner etc.). OFF by default — must never run in production. (M3) */
  seedDemoUsers?: boolean;
}

export async function setupTenant(db: Db, input: TenantSetupInput) {
  await seedSystemRolesAndPermissions(db);

  const holding = await findOrInsert(
    db,
    schema.holdings,
    eq(schema.holdings.name, input.holdingName),
    { name: input.holdingName },
  );
  const factoryName = input.factoryName ?? 'Главный завод';
  const factory = await findOrInsert(
    db,
    schema.factories,
    and(eq(schema.factories.holdingId, holding.id), eq(schema.factories.name, factoryName)),
    { holdingId: holding.id, name: factoryName },
  );

  let [workflow] = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.holdingId, holding.id), eq(schema.workflows.name, WORKFLOW_NAME)));
  if (!workflow) {
    [workflow] = await db
      .insert(schema.workflows)
      .values({ holdingId: holding.id, name: WORKFLOW_NAME, isActive: true })
      .returning();
    for (const s of STEP_SPECS) {
      await db.insert(schema.workflowSteps).values({
        workflowId: workflow.id,
        stepOrder: s.order,
        stepName: s.name,
        stepKind: s.kind,
        approverRoleId: await roleIdByCode(db, s.code),
        conditionRule: s.condition ?? null,
        thresholdAmount: s.threshold ?? null,
      });
    }
  }

  const settings: [string, string][] = [
    ['currency', 'UZS'],
    ['factory_name', input.holdingName],
    ['payment_types', 'Перечисление, Наличные'],
  ];
  for (const [key, value] of settings) {
    await findOrInsert(
      db,
      schema.settings,
      and(eq(schema.settings.holdingId, holding.id), eq(schema.settings.key, key)),
      { holdingId: holding.id, key, value },
    );
  }

  let owner: { id: string; telegramId: string | null } | null = null;
  if (input.ownerTelegramId) {
    let [u] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.telegramId, input.ownerTelegramId));
    if (!u) {
      [u] = await db
        .insert(schema.users)
        .values({
          telegramId: input.ownerTelegramId,
          fullName: input.ownerName ?? 'Owner',
          holdingId: holding.id,
          status: 'active',
        })
        .returning();
    } else if (!u.holdingId) {
      await db.update(schema.users).set({ holdingId: holding.id }).where(eq(schema.users.id, u.id));
    }
    const ownerRoleId = await roleIdByCode(db, 'owner');
    const existing = await db
      .select()
      .from(schema.userRoles)
      .where(
        and(
          eq(schema.userRoles.userId, u.id),
          eq(schema.userRoles.roleId, ownerRoleId as string),
          eq(schema.userRoles.holdingId, holding.id),
        ),
      );
    if (existing.length === 0) {
      await db
        .insert(schema.userRoles)
        .values({ userId: u.id, roleId: ownerRoleId as string, holdingId: holding.id });
    }
    owner = u;
  }

  // Demo warehouse + materials + stock so the warehouse search has data.
  const warehouse = await findOrInsert(
    db,
    schema.warehouses,
    and(eq(schema.warehouses.holdingId, holding.id), eq(schema.warehouses.name, 'Главный склад')),
    { holdingId: holding.id, name: 'Главный склад' },
  );
  const DEMO_MATERIALS: [string, string, number, number][] = [
    ['Хлопковая пряжа 40/1', 'кг', 1200, 500],
    ['Краситель синий 5R', 'кг', 45, 20],
    ['Масло гидравлическое HLP-46', 'л', 15, 30],
    ['Ремень приводной A-1250', 'шт', 8, 10],
    ['Хлопок-волокно 1 сорт', 'кг', 3400, 800],
    ['Нить полиэстер 150D', 'кг', 600, 200],
    ['Подшипник SKF 6205', 'шт', 12, 5],
    ['Мыло хозяйственное', 'шт', 100, 20],
  ];
  for (const [name, unit, qty, minQty] of DEMO_MATERIALS) {
    const mat = await findOrInsert(
      db,
      schema.materials,
      and(eq(schema.materials.holdingId, holding.id), eq(schema.materials.name, name)),
      { holdingId: holding.id, name, normalizedName: name.toLowerCase(), defaultUnit: unit, status: 'active' },
    );
    const existing = await db
      .select()
      .from(schema.stockBalances)
      .where(
        and(
          eq(schema.stockBalances.holdingId, holding.id),
          eq(schema.stockBalances.warehouseId, warehouse.id),
          eq(schema.stockBalances.materialId, mat.id),
        ),
      );
    if (existing.length === 0) {
      await db.insert(schema.stockBalances).values({
        holdingId: holding.id,
        warehouseId: warehouse.id,
        materialId: mat.id,
        availableQty: String(qty),
        minQty: String(minQty),
      });
    }
  }

  // Demo users (one per system role) for dev login / role switcher. M3 fix: seeded ONLY
  // when explicitly requested — the CLI passes seedDemoUsers=false in production, so the
  // loop runs over an empty list and no demo_* accounts land in a prod tenant.
  const DEMO_ROLES = input.seedDemoUsers
    ? ['requester', 'dept_head', 'warehouse', 'procurement', 'finance', 'director', 'owner', 'admin']
    : [];
  for (const code of DEMO_ROLES) {
    const tgId = 'demo_' + code;
    let [du] = await db.select().from(schema.users).where(eq(schema.users.telegramId, tgId));
    if (!du) {
      [du] = await db
        .insert(schema.users)
        .values({ telegramId: tgId, fullName: 'Demo ' + code, holdingId: holding.id, status: 'active' })
        .returning();
    } else if (!du.holdingId) {
      await db.update(schema.users).set({ holdingId: holding.id }).where(eq(schema.users.id, du.id));
    }
    const rid = await roleIdByCode(db, code);
    if (rid) {
      const existing = await db
        .select()
        .from(schema.userRoles)
        .where(
          and(
            eq(schema.userRoles.userId, du.id),
            eq(schema.userRoles.roleId, rid),
            eq(schema.userRoles.holdingId, holding.id),
          ),
        );
      if (existing.length === 0) {
        await db.insert(schema.userRoles).values({ userId: du.id, roleId: rid, holdingId: holding.id });
      }
    }
  }

  await seedFormFields(db, holding.id);

  return { holding, factory, workflow, owner };
}
