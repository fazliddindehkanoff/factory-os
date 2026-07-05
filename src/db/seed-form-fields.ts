/**
 * Seeds the default, admin-editable create-form schema for a holding.
 *
 * `system: true` fields map to real request columns on submit; `system: false`
 * fields are custom and stored in requests.custom_fields (jsonb). The whole set
 * is later editable in the admin form builder — this is only the starting point.
 */
import { and, eq } from 'drizzle-orm';
import * as schema from './schema.js';

type Db = any;

interface SeedField {
  fieldKey: string;
  label: string;
  fieldType: 'text' | 'textarea' | 'number' | 'select' | 'date' | 'checkbox' | 'file';
  system: boolean;
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string; meta?: string }[];
  stepGroup: number;
  orderIndex: number;
}

export const DEFAULT_REQUEST_CREATE_FIELDS: SeedField[] = [
  // ── Step 1: Реквизиты ──
  {
    fieldKey: 'requestType',
    label: 'Тип заявки',
    fieldType: 'select',
    system: true,
    required: true,
    options: [
      { value: 'material_request', label: 'Материал' },
      { value: 'service_request', label: 'Услуга' },
      { value: 'repair_request', label: 'Ремонт' },
    ],
    stepGroup: 1,
    orderIndex: 1,
  },
  {
    fieldKey: 'warehouse',
    label: 'Склад назначения',
    fieldType: 'select',
    system: true,
    // options left empty → the wizard fills them from the holding's warehouses.
    options: [],
    stepGroup: 1,
    orderIndex: 2,
  },
  {
    // №7: заявка адресуется отделу — его руководитель увидит её на своём шаге.
    // options пустые → мастер подставляет отделы холдинга (value = id отдела).
    fieldKey: 'department',
    label: 'Отдел',
    fieldType: 'select',
    system: true,
    options: [],
    stepGroup: 1,
    orderIndex: 3,
  },
  {
    fieldKey: 'purpose',
    label: 'Назначение / цель',
    fieldType: 'select',
    system: false,
    // №3: >4 вариантов — первые 4 кнопками, остальные в выпадашке «Другое…».
    options: [
      { value: 'repair', label: 'Ремонт оборудования' },
      { value: 'production', label: 'Производство' },
      { value: 'household', label: 'Хоз. нужды' },
      { value: 'office', label: 'Офис / канцелярия' },
      { value: 'equipment', label: 'Новое оборудование' },
      { value: 'safety', label: 'Охрана труда / безопасность' },
      { value: 'packaging', label: 'Упаковка' },
      { value: 'logistics', label: 'Логистика / транспорт' },
      { value: 'it', label: 'IT / связь' },
      { value: 'other', label: 'Прочее' },
    ],
    stepGroup: 1,
    orderIndex: 4,
  },
  {
    fieldKey: 'priority',
    label: 'Степень срочности',
    fieldType: 'select',
    system: true,
    required: true,
    options: [
      { value: 'normal', label: 'Стандартная', meta: '3–7 дн.' },
      { value: 'high', label: 'Срочная', meta: '1–3 дн.' },
      { value: 'urgent', label: 'Аварийная', meta: 'Немедленно' },
    ],
    stepGroup: 1,
    orderIndex: 5,
  },
  // ── Step 2: Позиция ──
  {
    fieldKey: 'itemName',
    label: 'Наименование товара / материала',
    fieldType: 'text',
    system: true,
    required: true,
    placeholder: 'напр. Хлопковая пряжа 40/1',
    stepGroup: 2,
    orderIndex: 1,
  },
  {
    fieldKey: 'itemCode',
    label: 'Код товара',
    fieldType: 'text',
    system: false,
    placeholder: 'напр. YRN-40-WHT',
    stepGroup: 2,
    orderIndex: 2,
  },
  {
    fieldKey: 'quantity',
    label: 'Количество',
    fieldType: 'number',
    system: true,
    required: true,
    placeholder: '0',
    stepGroup: 2,
    orderIndex: 3,
  },
  {
    fieldKey: 'unit',
    label: 'Единица измерения',
    fieldType: 'select',
    system: true,
    options: ['шт', 'кг', 'г', 'л', 'м', 'т', 'м²', 'рулон', 'упак'].map((u) => ({ value: u, label: u })),
    stepGroup: 2,
    orderIndex: 4,
  },
  {
    fieldKey: 'neededDate',
    label: 'Необходимо к дате',
    fieldType: 'date',
    system: true,
    stepGroup: 2,
    orderIndex: 5,
  },
  {
    fieldKey: 'note',
    label: 'Примечание',
    fieldType: 'textarea',
    system: true,
    placeholder: 'Спецификации или контекст для склада и снабжения.',
    stepGroup: 2,
    orderIndex: 6,
  },
  {
    fieldKey: 'attachment',
    label: 'Вложение',
    fieldType: 'file',
    system: false,
    stepGroup: 2,
    orderIndex: 7,
  },
];

/**
 * Seeds the default form ONCE per (holding, screen). After the first run a
 * `form_seeded:<screen>` flag is stored, and every later call is a no-op — so the
 * admin's customised (or intentionally emptied) form is NEVER overwritten, even
 * if they deleted every field on purpose.
 */
export async function seedFormFields(db: Db, holdingId: string, screen = 'request_create'): Promise<number> {
  const flagKey = `form_seeded:${screen}`;
  const [flag] = await db
    .select()
    .from(schema.settings)
    .where(and(eq(schema.settings.holdingId, holdingId), eq(schema.settings.key, flagKey)));
  const existing = await db
    .select()
    .from(schema.formFields)
    .where(and(eq(schema.formFields.holdingId, holdingId), eq(schema.formFields.screen, screen)));

  // Already configured (flag set, or fields already exist from a pre-flag install):
  // mark as seeded and never touch the form again.
  if (flag || existing.length > 0) {
    if (!flag) {
      await db.insert(schema.settings).values({ holdingId, key: flagKey, value: '1' }).onConflictDoNothing();
    }
    return 0;
  }

  for (const f of DEFAULT_REQUEST_CREATE_FIELDS) {
    await db
      .insert(schema.formFields)
      .values({
        holdingId,
        screen,
        fieldKey: f.fieldKey,
        label: f.label,
        fieldType: f.fieldType,
        system: f.system,
        required: f.required ?? false,
        enabled: true,
        placeholder: f.placeholder ?? null,
        options: f.options ?? null,
        stepGroup: f.stepGroup,
        orderIndex: f.orderIndex,
      })
      .onConflictDoNothing();
  }
  await db.insert(schema.settings).values({ holdingId, key: flagKey, value: '1' }).onConflictDoNothing();
  return DEFAULT_REQUEST_CREATE_FIELDS.length;
}
