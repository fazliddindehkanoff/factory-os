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

  await seedDefaultRejectionReasons(db);
}

/** Bug #3: seed system-default rejection reasons (holding_id NULL). Idempotent —
 *  skips if any system defaults already exist, so owner edits are never overwritten. */
export async function seedDefaultRejectionReasons(db: Db): Promise<void> {
  const existing = await db.select({ id: schema.rejectionReasons.id }).from(schema.rejectionReasons).where(isNull(schema.rejectionReasons.holdingId));
  if (existing.length > 0) return;
  const DEFAULTS: { role: string | null; reasons: string[] }[] = [
    { role: 'dept_head', reasons: ['Необходимость не обоснована', 'Дубликат заявки', 'Недостаточно данных в заявке', 'Неверно указан отдел/завод', 'Сейчас не приоритетно'] },
    { role: 'warehouse', reasons: ['Нет на складе', 'Товар повреждён / брак', 'Пересорт (не тот товар)', 'Неверное количество или единицы', 'Требуется уточнение по позиции'] },
    { role: 'deputy_director', reasons: ['Превышает бюджет', 'Требует согласования выше', 'Обоснование недостаточно', 'Отложить на следующий период'] },
    { role: 'procurement_head', reasons: ['Нет подходящего поставщика', 'Цена завышена', 'Нужно дополнительное КП', 'Условия поставки не подходят'] },
    { role: 'procurement_manager', reasons: ['Поставщик недоступен', 'Сроки поставки не устраивают', 'Нет в наличии у поставщика'] },
    { role: 'director', reasons: ['Превышает лимит', 'Не одобрено руководством', 'Требует доработки'] },
    { role: 'finance', reasons: ['Нет бюджета', 'Неверная сумма', 'Нет подтверждающих документов', 'Возможный дублирующий платёж'] },
    { role: 'finance_head', reasons: ['Нет бюджета', 'Неверная сумма', 'Нет подтверждающих документов'] },
    { role: null, reasons: ['Ошибочная заявка', 'Создана по ошибке / тест'] },
  ];
  const rows: { holdingId: null; roleCode: string | null; text: string; sortOrder: number }[] = [];
  for (const g of DEFAULTS) g.reasons.forEach((text, i) => rows.push({ holdingId: null, roleCode: g.role, text, sortOrder: i }));
  if (rows.length) await db.insert(schema.rejectionReasons).values(rows);
}
