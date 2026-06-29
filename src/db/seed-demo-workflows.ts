/**
 * Demo workflows seed (dev/staging/local ONLY — never production).
 *
 * Extends the pilot org (Zelal Group, from seed:pilot — left untouched) with a
 * richer flow and demo requests parked on the procurement and finance steps so
 * the Procurement and Finance Mini App screens have something to exercise:
 *
 *   Demo Full Workflow: approval → warehouse_check → procurement →
 *                       finance_payment → receiving → issue → close
 *   • «Demo: заявка в закупке»  — parked at the procurement step
 *   • «Demo: заявка на оплате»  — parked at finance_payment (no invoice yet,
 *                                 so finance can exercise «Выставить счёт»)
 *
 * Idempotent: stable lookups by telegram id / workflow name / request title.
 */
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { seedPilot, PILOT_PIN } from './seed-pilot.js';
import { createRequest } from '../services/request.service.js';
import { hashPin } from '../auth/pin.js';
import { statusForStep } from '../workflow/step-kinds.js';

type Db = any;

// Extra PIN-gated demo users for the procurement/finance roles (seed:pilot only
// covers requester/director/warehouse/admin).
const DEMO_USERS = [
  { tg: 'demo_procurement', name: 'Demo Procurement', role: 'procurement' },
  { tg: 'demo_finance', name: 'Demo Finance', role: 'finance' },
];

// Inactive demo workflow (so it never overrides the active Pilot Workflow when a
// request is created); demo requests are pointed at its steps explicitly.
const STEP_SPECS = [
  { code: 'director', order: 1, name: 'Согласование', kind: 'approval' },
  { code: 'warehouse', order: 2, name: 'Проверка склада', kind: 'warehouse_check' },
  { code: 'procurement', order: 3, name: 'Снабжение', kind: 'procurement' },
  { code: 'finance', order: 4, name: 'Оплата', kind: 'finance_payment' },
  { code: 'warehouse', order: 5, name: 'Приёмка', kind: 'receiving' },
  { code: 'warehouse', order: 6, name: 'Выдача', kind: 'issue' },
  { code: 'requester', order: 7, name: 'Закрытие', kind: 'close' },
];

async function roleId(db: Db, code: string): Promise<string | undefined> {
  const [r] = await db
    .select()
    .from(schema.roles)
    .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r?.id;
}

export async function seedDemoWorkflows(db: Db) {
  const base = await seedPilot(db);
  const { holding, factory, users, materials } = base;

  // Demo procurement + finance users (PIN = PILOT_PIN).
  const demoUsers: Record<string, any> = {};
  for (const s of DEMO_USERS) {
    let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, s.tg));
    if (!u) {
      [u] = await db
        .insert(schema.users)
        .values({ holdingId: holding.id, telegramId: s.tg, fullName: s.name, status: 'active', pinHash: hashPin(PILOT_PIN) })
        .returning();
    }
    const rid = await roleId(db, s.role);
    const exists = await db
      .select()
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.roleId, rid as string)));
    if (exists.length === 0) {
      await db.insert(schema.userRoles).values({ userId: u.id, roleId: rid, holdingId: holding.id });
    }
    demoUsers[s.role] = u;
  }

  // Demo workflow (inactive).
  let [wf] = await db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.holdingId, holding.id), eq(schema.workflows.name, 'Demo Full Workflow')));
  if (!wf) {
    [wf] = await db
      .insert(schema.workflows)
      .values({ holdingId: holding.id, name: 'Demo Full Workflow', isActive: false })
      .returning();
    for (const s of STEP_SPECS) {
      await db.insert(schema.workflowSteps).values({
        workflowId: wf.id,
        stepOrder: s.order,
        stepName: s.name,
        stepKind: s.kind,
        approverRoleId: await roleId(db, s.code),
      });
    }
  }
  const steps = await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.workflowId, wf.id));
  const stepByKind = (k: string) => steps.find((x: { stepKind: string }) => x.stepKind === k);

  // Park a demo request at a given step kind (idempotent by title).
  const place = async (title: string, kind: string) => {
    const existing = await db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.holdingId, holding.id), eq(schema.requests.title, title)));
    if (existing.length) return existing[0];
    const req = await createRequest(db, {
      holdingId: holding.id,
      requesterId: users.requester.id,
      factoryId: factory.id,
      title,
      items: [{ name: materials.inStock.name, materialId: materials.inStock.id, quantity: 5, unitPrice: 1_000_000 }],
    });
    const step = stepByKind(kind);
    await db
      .update(schema.requests)
      .set({ workflowId: wf.id, currentStepId: step.id, status: statusForStep(step) })
      .where(eq(schema.requests.id, req.id));
    return req;
  };

  const procRequest = await place('Demo: заявка в закупке', 'procurement');
  const finRequest = await place('Demo: заявка на оплате', 'finance_payment');

  return { holding, workflow: wf, demoUsers, procRequestId: procRequest.id, finRequestId: finRequest.id, pin: PILOT_PIN };
}
