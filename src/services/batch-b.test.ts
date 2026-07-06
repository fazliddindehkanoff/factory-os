/**
 * QA-пакет B (2026-07-06):
 *  - №11: действие «Вернуть на доработку» (return_revision) — независимо от
 *    политики on_reject; комментарий обязателен; автор возвращает через resubmit;
 *  - №16б: перед шагом закупки «Согласовать» скрыт и запрещён — только
 *    «Передать снабженцу» (assign_procurement);
 *  - №15: настройка холдинга require_pin — '0' переключает подпись с PIN на
 *    обычное подтверждение (pin: false в actions, performAction без pin);
 *  - №9: unreadCount считает и pending/failed уведомления (не только delivered);
 *  - №14: сводка «Заявки по статусам» — по праву reports.status_summary;
 *  - №8: KPI «Ожидают меня» и инбокс совпадают для всех ролей на каждом шаге.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { availableActions, performAction, inboxCandidates, holdingRequiresPin } from './lifecycle.service.js';
import { getDashboard } from './dashboard.service.js';
import { unreadCount, markAllRead, listUserNotifications } from './notification.service.js';
import { hashPin } from '../auth/pin.js';

const PIN = '1234';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  return db;
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function mkUser(db: any, holdingId: string, roleCodes: string[], tg: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active', pinHash: hashPin(PIN) })
    .returning();
  for (const code of roleCodes) {
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId });
  }
  return u.id;
}
const acts = (list: { action: string }[]) => list.map((a) => a.action);
const reload = async (db: any, id: string) => {
  const [r] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
  return r;
};
async function org(db: any) {
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  return { h, f };
}

describe('№11 — «Вернуть на доработку» (return_revision)', () => {
  /** 1: согласование склада (on_reject=cancel!) → 2: закрытие автором. */
  async function flow(db: any, h: any, f: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      {
        workflowId: wf.id,
        stepOrder: 1,
        stepName: 'Нач. склада',
        stepKind: 'approval',
        approverRoleId: await roleId(db, 'warehouse'),
        onReject: 'cancel', // важно: доработка работает НЕЗАВИСИМО от политики
      },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  }

  it('ответственный видит действие; без комментария отказ; с комментарием — needs_revision → resubmit', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const req = await flow(db, h, f, requester);

    const whActs = acts(await availableActions(db, await reload(db, req.id), wh));
    expect(whActs).toContain('return_revision');
    expect(whActs).toContain('reject');

    // комментарий «что исправить» обязателен
    await expect(
      performAction(db, { requestId: req.id, action: 'return_revision', actor: { id: wh, holdingId: h.id } }),
    ).rejects.toThrow(/комментарий/i);

    await performAction(db, {
      requestId: req.id,
      action: 'return_revision',
      actor: { id: wh, holdingId: h.id },
      comment: 'уточните количество и код товара',
    });
    let r = await reload(db, req.id);
    expect(r.status).toBe('needs_revision');
    expect(r.currentStepId).toBeNull();
    expect(r.closedAt).toBeNull();

    // pending-согласование снято как cancelled, подписи нет
    const appr = await db.select().from(schema.approvals).where(eq(schema.approvals.requestId, req.id));
    expect(appr.filter((a: any) => a.status === 'cancelled').length).toBe(1);
    const sigs = await db.select().from(schema.signatures).where(eq(schema.signatures.requestId, req.id));
    expect(sigs.length).toBe(0);

    // автор возвращает заявку в маршрут
    expect(acts(await availableActions(db, r, requester))).toEqual(['resubmit']);
    await performAction(db, { requestId: req.id, action: 'resubmit', actor: { id: requester, holdingId: h.id } });
    r = await reload(db, req.id);
    expect(r.status).toBe('pending_approval');
  });

  it('вернуть на доработку может только ответственный за шаг', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    await mkUser(db, h.id, ['warehouse'], 'wh');
    const dir = await mkUser(db, h.id, ['director'], 'dir'); // есть approvals.reject, но шаг не его
    const req = await flow(db, h, f, requester);

    await expect(
      performAction(db, { requestId: req.id, action: 'return_revision', actor: { id: dir, holdingId: h.id }, comment: 'x' }),
    ).rejects.toThrow(/ответственный/);
  });
});

describe('№16б — перед закупкой только «Передать снабженцу»', () => {
  async function flow(db: any, h: any, f: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W16', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. снабжения', stepKind: 'approval', approverRoleId: await roleId(db, 'procurement_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement_manager') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 2, unitPrice: 10 }] });
  }

  it('approve скрыт и запрещён; assign_procurement назначает и продвигает', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const ph = await mkUser(db, h.id, ['procurement_head'], 'ph');
    const snab = await mkUser(db, h.id, ['procurement_manager'], 'snab');
    const req = await flow(db, h, f, requester);

    const a = acts(await availableActions(db, await reload(db, req.id), ph));
    expect(a).toContain('assign_procurement');
    expect(a).not.toContain('approve');

    await expect(
      performAction(db, { requestId: req.id, action: 'approve', actor: { id: ph, holdingId: h.id }, pin: PIN }),
    ).rejects.toThrow(/снабженц/i);

    await performAction(db, {
      requestId: req.id,
      action: 'assign_procurement',
      actor: { id: ph, holdingId: h.id },
      pin: PIN,
      assigneeId: snab,
    });
    const r = await reload(db, req.id);
    expect(r.status).toBe('procurement');
    expect(r.responsibleUserId).toBe(snab);
  });

  it('F1: если снабженец уже назначен, approve перед вторым шагом закупки остаётся', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const ph = await mkUser(db, h.id, ['procurement_head'], 'ph');
    const dir = await mkUser(db, h.id, ['director'], 'dir');
    const snab = await mkUser(db, h.id, ['procurement_manager'], 'snab');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'WF1', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'РОС', stepKind: 'approval', approverRoleId: await roleId(db, 'procurement_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement_manager') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId(db, 'director') },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Доставка (закупка 2)', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement_manager') },
      { workflowId: wf.id, stepOrder: 5, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    const req = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 3 }] });

    await performAction(db, { requestId: req.id, action: 'assign_procurement', actor: { id: ph, holdingId: h.id }, pin: PIN, assigneeId: snab });
    await performAction(db, { requestId: req.id, action: 'add_quotation', actor: { id: snab, holdingId: h.id }, amount: 500, supplierName: 'ООО X' });
    const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.id));

    // Выбор поставщика — ТОЛЬКО руководитель снабжения (2026-07-06): у снабженца
    // права нет вовсе, а руководителя назначение исполнителя не запирает.
    await expect(
      performAction(db, { requestId: req.id, action: 'select_supplier', actor: { id: snab, holdingId: h.id }, quotationId: q.id }),
    ).rejects.toThrow(/Недостаточно прав/);
    const snabActs = acts(await availableActions(db, await reload(db, req.id), snab));
    expect(snabActs).toContain('add_quotation');
    expect(snabActs).not.toContain('select_supplier');
    const phActs = acts(await availableActions(db, await reload(db, req.id), ph));
    expect(phActs).toContain('select_supplier');
    await performAction(db, { requestId: req.id, action: 'select_supplier', actor: { id: ph, holdingId: h.id }, quotationId: q.id });

    // Шаг «Директор» перед ВТОРОЙ закупкой: исполнитель уже назначен → approve есть.
    const dirActs = acts(await availableActions(db, await reload(db, req.id), dir));
    expect(dirActs).toContain('approve');
    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: dir, holdingId: h.id }, pin: PIN });
    const r = await reload(db, req.id);
    expect(r.status).toBe('procurement');
    expect(r.responsibleUserId).toBe(snab); // назначение сохранилось
  });

  it('если следующий шаг НЕ закупка (in stock → закупка выпадает), approve остаётся', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const ph = await mkUser(db, h.id, ['procurement_head'], 'ph');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W16b', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Рук. снабжения', stepKind: 'approval', approverRoleId: await roleId(db, 'procurement_head') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Закупка', stepKind: 'procurement', approverRoleId: await roleId(db, 'procurement_manager'), conditionRule: { inStock: false } },
      { workflowId: wf.id, stepOrder: 4, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    const req = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });

    // склад: «в наличии» → шаг закупки становится неприменим
    await performAction(db, { requestId: req.id, action: 'wh_in_stock', actor: { id: wh, holdingId: h.id } });
    const a = acts(await availableActions(db, await reload(db, req.id), ph));
    expect(a).toContain('approve');
    expect(a).not.toContain('assign_procurement');
  });
});

describe('№15 — настройка require_pin', () => {
  async function flow(db: any, h: any, f: any, requesterId: string) {
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W15', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId(db, 'director') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);
    return createRequest(db, { holdingId: h.id, requesterId, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 7 }] });
  }

  it('по умолчанию PIN обязателен; require_pin=0 → действия без PIN, pin:false в actions', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const dir = await mkUser(db, h.id, ['director'], 'dir');
    const req = await flow(db, h, f, requester);

    expect(await holdingRequiresPin(db, h.id)).toBe(true);
    let dirActs = await availableActions(db, await reload(db, req.id), dir);
    expect(dirActs.find((x) => x.action === 'approve')!.pin).toBe(true);
    await expect(
      performAction(db, { requestId: req.id, action: 'approve', actor: { id: dir, holdingId: h.id } }),
    ).rejects.toThrow(/PIN/);

    await db.insert(schema.settings).values({ holdingId: h.id, key: 'require_pin', value: '0' });
    expect(await holdingRequiresPin(db, h.id)).toBe(false);
    dirActs = await availableActions(db, await reload(db, req.id), dir);
    expect(dirActs.find((x) => x.action === 'approve')!.pin).toBe(false);

    await performAction(db, { requestId: req.id, action: 'approve', actor: { id: dir, holdingId: h.id } });
    const r = await reload(db, req.id);
    expect(r.status).toBe('close'); // следующий шаг — закрытие автором
    // подпись согласования всё равно записана (кто/когда)
    const sigs = await db.select().from(schema.signatures).where(eq(schema.signatures.requestId, req.id));
    expect(sigs.length).toBe(1);
  });
});

describe('№9 — unreadCount и непрочитанные', () => {
  it('failed/pending считаются непрочитанными; markAllRead гасит всё', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const uid = await mkUser(db, h.id, ['requester'], 'req');
    await db.insert(schema.notifications).values([
      { holdingId: h.id, recipientUserId: uid, title: 'a', message: 'm1', channel: 'telegram', status: 'delivered' },
      { holdingId: h.id, recipientUserId: uid, title: 'b', message: 'm2', channel: 'telegram', status: 'failed', errorMessage: 'no delivery channel configured' },
      { holdingId: h.id, recipientUserId: uid, title: 'c', message: 'm3', channel: 'telegram', status: 'pending' },
      { holdingId: h.id, recipientUserId: uid, title: 'd', message: 'm4', channel: 'telegram', status: 'read' },
    ]);
    expect(await unreadCount(db, uid)).toBe(3);
    expect((await listUserNotifications(db, uid, { unreadOnly: true })).length).toBe(3);
    expect(await markAllRead(db, uid)).toBe(3);
    expect(await unreadCount(db, uid)).toBe(0);
  });
});

describe('№14 — сводка по статусам по праву reports.status_summary', () => {
  it('dept_head (есть право) видит byStatus; requester — нет', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const head = await mkUser(db, h.id, ['dept_head'], 'head');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W14', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
    ]);
    await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 1 }] });

    const headDash = await getDashboard(db, head, h.id);
    expect(headDash.byStatus).not.toBeNull();
    const reqDash = await getDashboard(db, requester, h.id);
    expect(reqDash.byStatus).toBeNull();
  });
});

describe('№8 — KPI «Ожидают меня» == инбокс для каждой роли на каждом шаге', () => {
  it('dept_head → склад → закрытие: цифры совпадают на всех стадиях', async () => {
    const db = await setup();
    const { h, f } = await org(db);
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const head = await mkUser(db, h.id, ['dept_head'], 'head');
    const wh = await mkUser(db, h.id, ['warehouse'], 'wh');
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W8', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Рук. отдела', stepKind: 'approval', approverRoleId: await roleId(db, 'dept_head') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Склад', stepKind: 'warehouse_check', approverRoleId: await roleId(db, 'warehouse') },
      { workflowId: wf.id, stepOrder: 3, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);

    const kpiEqualsInbox = async (userId: string): Promise<number> => {
      const cand = await inboxCandidates(db, userId, h.id);
      let n = 0;
      for (const r of cand) if ((await availableActions(db, r, userId)).length > 0) n++;
      const dash = await getDashboard(db, userId, h.id);
      expect(dash.pendingForMe).toBe(n);
      return n;
    };

    const r1 = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'A', quantity: 1, unitPrice: 1 }] });
    await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'B', quantity: 1, unitPrice: 1 }] });

    expect(await kpiEqualsInbox(head)).toBe(2);
    expect(await kpiEqualsInbox(wh)).toBe(0);
    expect(await kpiEqualsInbox(requester)).toBe(0);

    await performAction(db, { requestId: r1.id, action: 'approve', actor: { id: head, holdingId: h.id }, pin: PIN });
    expect(await kpiEqualsInbox(head)).toBe(1);
    expect(await kpiEqualsInbox(wh)).toBe(1);

    await performAction(db, { requestId: r1.id, action: 'wh_in_stock', actor: { id: wh, holdingId: h.id } });
    expect(await kpiEqualsInbox(wh)).toBe(0);
    expect(await kpiEqualsInbox(requester)).toBe(1); // закрытие — у автора
  });
});
