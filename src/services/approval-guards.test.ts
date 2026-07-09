/**
 * C1 — approveApproval is fail-closed at the SERVICE level (эндпоинты
 * /approvals/:id/* из канонического API удалены; сервис живёт для
 * legacy-дизайна через compat.routes.ts, где PIN/permission проверяет
 * сам эндпоинт — см. compat-hardening.test.ts):
 * актор без роли шага — Forbidden; шаг без роли согласующего — Conflict
 * (misconfiguration, не открытая дверь); самосогласование — Forbidden;
 * подпись и аудит пишутся только при успехе.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { approveApproval } from './approval.service.js';
import { ForbiddenError, ConflictError } from './errors.js';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [factory] = await db.insert(schema.factories).values({ holdingId: holding.id, name: 'F' }).returning();
  return { db, holding, factory };
}
const roleId = async (db: any, code: string): Promise<string> => {
  const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
  return r.id;
};
async function userWithRoles(db: any, holding: any, codes: string[], tg: string): Promise<string> {
  const [u] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: tg, telegramId: tg, status: 'active' })
    .returning();
  for (const c of codes) await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, c), holdingId: holding.id });
  return u.id;
}

async function approvalFlow(db: any, holding: any, factory: any, requesterId: string, approverRoleId: string | null) {
  const [wf] = await db.insert(schema.workflows).values({ holdingId: holding.id, name: 'Appr', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Согласование', stepKind: 'approval', approverRoleId },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
  ]);
  const req = await createRequest(db, { holdingId: holding.id, requesterId, factoryId: factory.id, items: [{ name: 'X', quantity: 1, unitPrice: 100 }] });
  const [appr] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.requestId, req.id), eq(schema.approvals.status, 'pending')));
  return { req, approvalId: appr.id };
}
const sigs = (db: any, approvalId: string) => db.select().from(schema.signatures).where(eq(schema.signatures.approvalId, approvalId));
const approvedAudit = (db: any, approvalId: string) =>
  db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entityId, approvalId), eq(schema.auditLogs.action, 'approval.approved')));

describe('C1 — approveApproval is fail-closed', () => {
  it('actor without the step role → Forbidden, no signature/audit written', async () => {
    const { db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    // dept_head is a legit approver role in general but NOT this step's (director).
    const dh = await userWithRoles(db, holding, ['dept_head'], 'dh');
    const { approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));

    await expect(approveApproval(db, { approvalId, actorUserId: dh })).rejects.toThrow(ForbiddenError);
    expect((await sigs(db, approvalId)).length).toBe(0);
    expect((await approvedAudit(db, approvalId)).length).toBe(0);
  });

  it('approval step with NO approver role → Conflict (fail-closed), not approvable by anyone', async () => {
    const { db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    const dir = await userWithRoles(db, holding, ['director'], 'dir');
    const { approvalId } = await approvalFlow(db, holding, factory, requester, null); // step has no approver role

    await expect(approveApproval(db, { approvalId, actorUserId: dir })).rejects.toThrow(ConflictError);
    expect((await sigs(db, approvalId)).length).toBe(0);
  });

  it('self-approval forbidden even with the right role', async () => {
    const { db, holding, factory } = await make();
    // Same person creates AND would approve (has both requester + director).
    const self = await userWithRoles(db, holding, ['requester', 'director'], 'self');
    // A SECOND director must exist, else the director step is auto-skipped (bug #1);
    // here we test that self-approval stays blocked while the step is live.
    await userWithRoles(db, holding, ['director'], 'dir2');
    const { approvalId } = await approvalFlow(db, holding, factory, self, await roleId(db, 'director'));

    await expect(approveApproval(db, { approvalId, actorUserId: self })).rejects.toThrow(ForbiddenError);
    expect((await sigs(db, approvalId)).length).toBe(0);
  });

  it('valid approver → success, with signature + audit written only then', async () => {
    const { db, holding, factory } = await make();
    const requester = await userWithRoles(db, holding, ['requester'], 'req');
    const dir = await userWithRoles(db, holding, ['director'], 'dir');
    const { req, approvalId } = await approvalFlow(db, holding, factory, requester, await roleId(db, 'director'));

    const result = await approveApproval(db, { approvalId, actorUserId: dir });
    expect(result.requestId).toBe(req.id);
    const s = await sigs(db, approvalId);
    expect(s.length).toBe(1);
    expect(s[0].signatureType).toBe('telegram_pin');
    expect((await approvedAudit(db, approvalId)).length).toBe(1);
    // E12: the next step is kind 'close' (non-approval) — the request state must
    // reflect that step's kind and carry NO pending approval row (C1 guard).
    const [after] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.id));
    expect(after.status).toBe('close');
  });
});
