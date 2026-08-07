/**
 * Deterministic QA seed — the multi-window role-testing mode (see docs/TEST_MODE.md).
 * Its own holding («Тестовый завод») with one test user per role of the full
 * request path, so the scenario can be walked end-to-end without ever switching
 * the role on a single Telegram account:
 *
 *   sklad_01 создаёт → nach_sklad_01 подтверждает → snab_01 (предложение + одобрение) →
 *   zamdir_01 → gendir_01 → founder_01 → прибытие (финальный шаг).
 *
 * Each user logs in through dev auth (telegramId = username below), i.e. the
 * mini app URL `/?user=sklad_01` — one browser window per user. PIN everywhere
 * is TEST_PIN. Idempotent (лукапы по стабильным именам/username). Seed only —
 * never run against production data (the CLI refuses NODE_ENV=production).
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { seedSystemRolesAndPermissions } from './seed.js';
import { seedFormFields } from './seed-form-fields.js';
import { hashPin } from '../auth/pin.js';
import { createRequest } from '../services/request.service.js';
import { performAction } from '../services/lifecycle.service.js';

type Db = any;

export const TEST_PIN = '1234';
export const TEST_HOLDING_NAME = 'Тестовый завод';

export interface TestUserSpec {
  /** Логин dev-входа (хранится как users.telegramId). */
  username: string;
  /** Детерминированный телефон для входа через web app в тест-режиме. */
  phone: string;
  name: string;
  /** Коды системных ролей (holding-scoped назначение). */
  roles: string[];
  department: 'Склад' | 'Снабжение' | 'Дирекция';
}

/** Тестовые пользователи — по одному на КАЖДУЮ системную роль (см. system-roles.ts).
 * Первые семь — маршрут заявки из ТЗ, остальные — вспомогательные/наблюдающие роли. */
export const TEST_USERS: TestUserSpec[] = [
  { username: 'zayavitel_01', phone: '998900000001', name: 'Заявитель (сотрудник отдела)', roles: ['requester'], department: 'Дирекция' },
  { username: 'sklad_01', phone: '998900000002', name: 'Склад (кладовщик)', roles: ['requester', 'warehouse_worker'], department: 'Склад' },
  { username: 'nach_sklad_01', phone: '998900000003', name: 'Начальник склада', roles: ['warehouse'], department: 'Склад' },
  { username: 'snab_01', phone: '998900000004', name: 'Снабженец', roles: ['procurement_manager'], department: 'Снабжение' },
  { username: 'zamdir_01', phone: '998900000005', name: 'Главный инженер', roles: ['deputy_director'], department: 'Дирекция' },
  { username: 'gendir_01', phone: '998900000006', name: 'Ген. директор', roles: ['director'], department: 'Дирекция' },
  { username: 'founder_01', phone: '998900000007', name: 'Учредитель', roles: ['owner'], department: 'Дирекция' },
  { username: 'admin_01', phone: '998900000008', name: 'Администратор', roles: ['admin'], department: 'Дирекция' },
  { username: 'nach_snab_01', phone: '998900000009', name: 'Руководитель снабжения', roles: ['procurement_head'], department: 'Снабжение' },
  { username: 'snab_otdel_01', phone: '998900000010', name: 'Снабжение (отдел)', roles: ['procurement'], department: 'Снабжение' },
  { username: 'fin_01', phone: '998900000011', name: 'Финансист', roles: ['finance'], department: 'Дирекция' },
  { username: 'nach_fin_01', phone: '998900000012', name: 'Руководитель финансов', roles: ['finance_head'], department: 'Дирекция' },
  { username: 'fin_manager_01', phone: '998900000013', name: 'Финансовый менеджер', roles: ['finance_manager'], department: 'Дирекция' },
  { username: 'buhgalter_01', phone: '998900000014', name: 'Бухгалтер', roles: ['accountant'], department: 'Дирекция' },
  { username: 'nach_otdela_01', phone: '998900000015', name: 'Руководитель отдела', roles: ['dept_head'], department: 'Дирекция' },
  { username: 'vnedrenie_01', phone: '998900000016', name: 'Руководитель внедрения', roles: ['operations_lead'], department: 'Дирекция' },
  { username: 'auditor_01', phone: '998900000017', name: 'Аудитор', roles: ['auditor'], department: 'Дирекция' },
  { username: 'nabludatel_01', phone: '998900000018', name: 'Наблюдатель', roles: ['observer'], department: 'Дирекция' },
];

export const TEST_USERNAMES = TEST_USERS.map((u) => u.username);

/** Полный маршрут из ТЗ на существующих step-kind'ах — без новых статусов. */
const STEP_SPECS = [
  { order: 1, name: 'Подтверждение начальника склада', kind: 'approval', role: 'warehouse' },
  { order: 2, name: 'Снабжение — предложение', kind: 'procurement', role: 'procurement_manager' },
  { order: 3, name: 'Снабжение — менеджер', kind: 'price_approval', role: 'procurement_head', onRejectStepOrder: 2 },
  { order: 4, name: 'Главный инженер', kind: 'approval', role: 'deputy_director' },
  { order: 5, name: 'Одобрение ген. директора', kind: 'approval', role: 'director' },
  { order: 6, name: 'Утверждение учредителя', kind: 'approval', role: 'owner' },
  { order: 7, name: 'Прибытие товара на склад', kind: 'delivery', role: 'procurement_manager' },
];

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

export async function seedTest(db: Db) {
  await seedSystemRolesAndPermissions(db);

  const holding = await findOrInsert(db, schema.holdings, eq(schema.holdings.name, TEST_HOLDING_NAME), {
    name: TEST_HOLDING_NAME,
  });
  const company = await findOrInsert(
    db,
    schema.companies,
    and(eq(schema.companies.holdingId, holding.id), eq(schema.companies.name, 'Тестовая компания')),
    { holdingId: holding.id, name: 'Тестовая компания', legalName: 'ООО «Тестовая компания»' },
  );
  const factory = await findOrInsert(
    db,
    schema.factories,
    and(eq(schema.factories.holdingId, holding.id), eq(schema.factories.name, 'Тестовый завод №1')),
    { holdingId: holding.id, companyId: company.id, name: 'Тестовый завод №1' },
  );
  const departments: Record<string, any> = {};
  for (const d of [
    { name: 'Склад', nameUz: 'Ombor', nameTr: 'Depo', type: 'warehouse' },
    { name: 'Снабжение', nameUz: "Ta'minot", nameTr: 'Tedarik', type: 'procurement' },
    { name: 'Дирекция', nameUz: 'Direksiya', nameTr: 'Yönetim', type: 'management' },
  ]) {
    const department = await findOrInsert(
      db,
      schema.departments,
      and(eq(schema.departments.holdingId, holding.id), eq(schema.departments.name, d.name)),
      { holdingId: holding.id, factoryId: factory.id, ...d },
    );
    await db.update(schema.departments).set({ nameUz: d.nameUz, nameTr: d.nameTr }).where(eq(schema.departments.id, department.id));
    departments[d.name] = department;
  }
  const warehouse = await findOrInsert(
    db,
    schema.warehouses,
    and(eq(schema.warehouses.holdingId, holding.id), eq(schema.warehouses.name, 'Основной склад (тест)')),
    { holdingId: holding.id, factoryId: factory.id, name: 'Основной склад (тест)', type: 'main' },
  );

  // The create-form is admin-configurable; without seeded fields the UI shows
  // «Форма создания заявки ещё не настроена» and testers can't create via the app.
  await seedFormFields(db, holding.id);

  const users: Record<string, any> = {};
  for (const s of TEST_USERS) {
    let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, s.username));
    if (!u) {
      [u] = await db
        .insert(schema.users)
        .values({
          holdingId: holding.id,
          telegramId: s.username,
          phone: s.phone,
          fullName: s.name,
          position: s.name,
          status: 'active',
          pinHash: hashPin(TEST_PIN),
        })
        .returning();
    } else {
      [u] = await db
        .update(schema.users)
        .set({ holdingId: holding.id, phone: s.phone, fullName: s.name, position: s.name, status: 'active', pinHash: hashPin(TEST_PIN) })
        .where(eq(schema.users.id, u.id))
        .returning();
    }
    for (const code of s.roles) {
      const rid = await roleId(db, code);
      if (!rid) throw new Error(`system role not found: ${code}`);
      const existing = await db
        .select()
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.roleId, rid)));
      if (existing.length === 0) {
        await db.insert(schema.userRoles).values({ userId: u.id, roleId: rid, holdingId: holding.id });
      }
    }
    const department = departments[s.department];
    const [existingDepartment] = await db
      .select()
      .from(schema.userDepartments)
      .where(and(eq(schema.userDepartments.userId, u.id), eq(schema.userDepartments.departmentId, department.id)));
    if (!existingDepartment) await db.insert(schema.userDepartments).values({ userId: u.id, departmentId: department.id });
    users[s.username] = u;
  }

  // Материалы + остатки в пуле холдинга (warehouseId=null — как в pilot-сиде:
  // lifecycle-шаги склада работают именно с этим пулом).
  const matSpecs = [
    { name: 'Подшипник 6205 (тест)', unit: 'шт', qty: '50', minQty: '10' },
    { name: 'Болт М10×40 (тест)', unit: 'шт', qty: '500', minQty: '100' },
    { name: 'Масло индустриальное И-20А (тест)', unit: 'л', qty: '0', minQty: '20' },
  ];
  for (const m of matSpecs) {
    const mat = await findOrInsert(
      db,
      schema.materials,
      and(eq(schema.materials.holdingId, holding.id), eq(schema.materials.name, m.name)),
      { holdingId: holding.id, name: m.name, normalizedName: m.name.toLowerCase(), defaultUnit: m.unit },
    );
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
  }

  let [workflow] = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.holdingId, holding.id), eq(schema.workflows.name, 'Тестовый маршрут (полный)')));
  if (!workflow) {
    [workflow] = await db
      .insert(schema.workflows)
      .values({ holdingId: holding.id, name: 'Тестовый маршрут (полный)', isActive: true })
      .returning();
    for (const s of STEP_SPECS) {
      await db.insert(schema.workflowSteps).values({
        workflowId: workflow.id,
        stepOrder: s.order,
        stepName: s.name,
        stepKind: s.kind,
        approverRoleId: await roleId(db, s.role),
        onRejectStepOrder: s.onRejectStepOrder ?? null,
      });
    }
  }

  // Тестовые заявки в разных состояниях — через боевые сервисы (createRequest /
  // performAction), чтобы approvals/история/аудит были настоящими, а не ручными
  // вставками. Лукап по title — сид можно перезапускать.
  const sklad = users['sklad_01'];
  const nachSklad = users['nach_sklad_01'];
  const requestsSeeded: Record<string, any> = {};

  async function seedRequest(title: string, items: { name: string; quantity: number; unitPrice: number; unit?: string }[]) {
    const [existing] = await db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.holdingId, holding.id), eq(schema.requests.title, title)));
    if (existing) return { req: existing, created: false };
    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: sklad.id,
      factoryId: factory.id,
      title,
      description: 'Тестовая заявка из seed:test — можно свободно прогонять по маршруту.',
      warehouseName: warehouse.name,
      items,
    });
    return { req, created: true };
  }

  const fresh = await seedRequest('ТЕСТ: заявка на болты (шаг 1 — нач. склада)', [
    { name: 'Болт М10×40', quantity: 200, unitPrice: 500, unit: 'шт' },
  ]);
  requestsSeeded.fresh = fresh.req;

  const inProc = await seedRequest('ТЕСТ: заявка на подшипники (шаг 2 — у снабженца)', [
    { name: 'Подшипник 6205', quantity: 20, unitPrice: 15000, unit: 'шт' },
  ]);
  if (inProc.created) {
    // №16б: следующий шаг — закупка, поэтому согласование = передача снабженцу.
    await performAction(db, {
      requestId: inProc.req.id,
      action: 'assign_procurement',
      actor: { id: nachSklad.id, holdingId: holding.id },
      pin: TEST_PIN,
      assigneeId: users['snab_01'].id,
    });
  }
  requestsSeeded.inProcurement = inProc.req;

  const rejected = await seedRequest('ТЕСТ: отклонённая заявка (пример отказа)', [
    { name: 'Масло И-20А', quantity: 100, unitPrice: 30000, unit: 'л' },
  ]);
  if (rejected.created) {
    await performAction(db, {
      requestId: rejected.req.id,
      action: 'reject',
      actor: { id: nachSklad.id, holdingId: holding.id },
      comment: 'Тестовый отказ: не согласовано начальником склада.',
    });
  }
  requestsSeeded.rejected = rejected.req;

  return { holding, company, factory, warehouse, workflow, users, requests: requestsSeeded, pin: TEST_PIN };
}
