/**
 * Idempotent seed of the global permission catalog and system roles.
 * Safe to run repeatedly (used by db:seed and by tests).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { SYSTEM_ROLES } from '../rbac/system-roles.js';

type Db = any;

export async function seedSystemRolesAndPermissions(db: Db): Promise<void> {
  // 1. Permissions — code is unique, so a plain upsert-nothing is idempotent.
  await db
    .insert(schema.permissions)
    .values(PERMISSIONS)
    .onConflictDoUpdate({
      target: schema.permissions.code,
      set: {
        name: sql`excluded.name`,
        module: sql`excluded.module`,
      },
    });

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
    // FIXES 2026-07-17 (листы D/F): склад — только «Требуется уточнение по позиции»
    // (плюс общие причины без роли); зам. директора / рук. снабжения — единый
    // короткий список с «Пересмотреть заявку», «Превышает бюджет» убрана.
    { role: 'warehouse', reasons: ['Требуется уточнение по позиции'] },
    { role: 'deputy_director', reasons: ['Требует согласования выше', 'Обоснование недостаточно', 'Отложить на следующий период', 'Пересмотреть заявку'] },
    { role: 'procurement_head', reasons: ['Требует согласования выше', 'Обоснование недостаточно', 'Отложить на следующий период', 'Пересмотреть заявку'] },
    { role: 'procurement_manager', reasons: ['Поставщик недоступен', 'Сроки поставки не устраивают', 'Нет в наличии у поставщика'] },
    // #9 «Директор — Вернуть на пересмотр»: фиксированный список причин (2026-07-11).
    // «Другое» добавляет сам UI (свободный ввод), поэтому здесь только конкретные.
    { role: 'director', reasons: ['Высокая цена', 'Неподходящий поставщик', 'Завышенное количество', 'Нет достаточного обоснования'] },
    { role: 'executive_director', reasons: ['Высокая цена', 'Неподходящий поставщик', 'Завышенное количество', 'Нет достаточного обоснования'] },
    { role: 'finance', reasons: ['Нет бюджета', 'Неверная сумма', 'Нет подтверждающих документов', 'Возможный дублирующий платёж'] },
    { role: 'finance_head', reasons: ['Нет бюджета', 'Неверная сумма', 'Нет подтверждающих документов'] },
    { role: null, reasons: ['Ошибочная заявка', 'Создана по ошибке / тест'] },
    // FIXES 2026-07-17 (лист G): псевдо-роль price_review — причины действия
    // «Пересмотреть цену» на шаге проверки цены (в общие списки не попадает).
    { role: 'price_review', reasons: ['Завышенная цена', 'Найти других поставщиков', 'Найти на перечисление', 'Сделать конкурентный лист'] },
  ];
  const rows: { holdingId: null; roleCode: string | null; text: string; sortOrder: number }[] = [];
  for (const g of DEFAULTS) g.reasons.forEach((text, i) => rows.push({ holdingId: null, roleCode: g.role, text, sortOrder: i }));
  if (rows.length) await db.insert(schema.rejectionReasons).values(rows);
}
