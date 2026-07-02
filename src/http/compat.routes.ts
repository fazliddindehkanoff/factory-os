/**
 * Compatibility API — serves the bundled design's exact contract (old endpoint
 * shapes / field names) on top of the new Postgres schema, so the design runs
 * unchanged. Field mapping lives here; the design is never edited.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { primaryRole } from './legacy-auth.js';
import { hasPermission, getUserPermissionCodes } from '../rbac/rbac.js';
import { getDashboard } from '../services/dashboard.service.js';
import { createRequest } from '../services/request.service.js';
import { approveApproval, rejectApproval } from '../services/approval.service.js';
import { isTerminalStatus } from '../workflow/step-kinds.js';
import { hashPin, verifyPin } from '../auth/pin.js';
import { pinLockoutRemaining, recordPinFailure, clearPinFailures } from './rate-limit.js';
import { receiveStock } from '../services/warehouse.service.js';

type Db = any;
type AuthedReq = Request & {
  dbUser: { id: string; telegramId: string | null; fullName: string; holdingId: string | null; status: string };
};

const URGENCY_BY_PRIORITY: Record<string, string> = {
  low: 'standard',
  normal: 'standard',
  high: 'urgent',
  urgent: 'urgent',
  critical: 'express',
};
const PRIORITY_BY_URGENCY: Record<string, 'low' | 'normal' | 'high' | 'urgent' | 'critical'> = {
  standard: 'normal',
  urgent: 'high',
  express: 'critical',
};
const AUDIT_ACTION: Record<string, string> = {
  'request.created': 'CREATE',
  'approval.approved': 'APPROVE',
  'approval.rejected': 'REJECT',
};

function legacyStatus(newStatus: string, stepRoleCode: string | undefined): string {
  if (newStatus === 'pending_approval') return stepRoleCode || 'pending';
  if (newStatus === 'approved') return 'closed';
  return newStatus; // draft, rejected
}

const pick = <T>(arr: T[], n = 50) => arr.slice(0, n);
const fmtDate = (d: unknown): string | null => (d ? new Date(d as string).toISOString().slice(0, 10) : null);

// Object-level authorization: staff (non-requester) see anything in their holding;
// a requester sees only their own requests.
function canAccessRequest(
  role: string,
  userId: string,
  holdingId: string | null,
  rq: { holdingId: string; requesterId: string },
): boolean {
  if (holdingId && rq.holdingId !== holdingId) return false;
  if (role === 'requester') return rq.requesterId === userId;
  return true;
}

export function buildCompatRouter(db: Db, devAuth = false): Router {
  const r = Router();

  // Compat strategy: the legacy layer must never be more dangerous than canonical.
  // In production, disable ALL legacy write operations (fail-closed: unset NODE_ENV
  // counts as production). Reads still work; every mutation must go through the
  // canonical API, which has the full permission/scope/PIN/audit guards. Business
  // mutations are additionally hardened below so dev/staging is safe too.
  const prodCompatReadOnly = (process.env.NODE_ENV ?? 'production') === 'production';
  if (prodCompatReadOnly) {
    r.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return; }
      res.status(410).json({
        error: 'Legacy compat mutations are disabled in production — use the canonical API.',
        code: 'COMPAT_READONLY',
      });
    });
  }

  // Map every workflow step id -> its approver role code (the old "status = stage name").
  async function stepRoleMap(): Promise<Map<string, string>> {
    const steps = await db
      .select({ id: schema.workflowSteps.id, code: schema.roles.code })
      .from(schema.workflowSteps)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.workflowSteps.approverRoleId));
    return new Map<string, string>(steps.map((s: { id: string; code: string }) => [s.id, s.code]));
  }

  async function namesByIds(ids: string[]): Promise<Map<string, string>> {
    const clean = [...new Set(ids.filter(Boolean))];
    if (!clean.length) return new Map();
    const us = await db.select().from(schema.users).where(inArray(schema.users.id, clean));
    return new Map<string, string>(us.map((u: { id: string; fullName: string }) => [u.id, u.fullName]));
  }

  r.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      const [first, ...rest] = (u.fullName || '').split(' ');
      res.json({
        id: u.id,
        telegram_id: u.telegramId,
        first_name: first || u.fullName,
        last_name: rest.join(' '),
        username: null,
        role,
        active: u.status === 'disabled' ? 0 : 1,
      });
    } catch (e) {
      next(e);
    }
  });

  r.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const d = await getDashboard(db, u.id, u.holdingId);
      const stats = [
        { value: String(d.myActive), label: 'Мои активные заявки', tint: 'accent', ic: 'file', go: ['requests', 'requests'] },
        { value: String(d.pendingForMe), label: 'Ожидают согласования', tint: 'warning', ic: 'checkCircle', go: ['approvals', 'approvals'] },
        { value: String(d.totalActive), label: 'Активных всего', tint: 'success', ic: 'box', go: ['requests', 'requests'] },
      ];
      const activity = d.activity.map((a) => ({
        title: a.requestNumber,
        sub: a.title || 'Без названия',
        time: fmtDate(a.updatedAt) ?? '',
        tint: a.status === 'rejected' ? 'danger' : a.status === 'approved' ? 'success' : 'accent',
        ic: 'file',
      }));
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      res.json({ stats, activity, role });
    } catch (e) {
      next(e);
    }
  });

  r.get('/requests', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      const role = await primaryRole(db, u.id);
      let rows = await db.select().from(schema.requests).where(eq(schema.requests.holdingId, u.holdingId));
      if (role === 'requester') rows = rows.filter((x: { requesterId: string }) => x.requesterId === u.id);

      const stepRole = await stepRoleMap();
      const items = await db.select().from(schema.requestItems);
      const itemsByReq = new Map<string, { name: string; quantity: string; unit: string | null; estimatedPrice: number }[]>();
      for (const it of items as { requestId: string; name: string; quantity: string; unit: string | null; estimatedPrice: number }[]) {
        if (!itemsByReq.has(it.requestId)) itemsByReq.set(it.requestId, []);
        itemsByReq.get(it.requestId)!.push(it);
      }

      let out = rows
        .sort((a: { updatedAt: unknown }, b: { updatedAt: unknown }) => new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime())
        .map((x: any) => ({
          id: x.id,
          req_number: x.requestNumber,
          status: legacyStatus(x.status, x.currentStepId ? stepRole.get(x.currentStepId) : undefined),
          urgency: URGENCY_BY_PRIORITY[x.priority] || 'standard',
          department: x.departmentName ?? '',
          warehouse: x.warehouseName ?? '',
          purpose: x.description ?? '',
          needed_by: fmtDate(x.neededDate),
          total_amount: x.estimatedAmount,
          created_at: x.createdAt,
          items: (itemsByReq.get(x.id) ?? []).map((it) => ({
            name: it.name,
            qty: Number(it.quantity),
            unit: it.unit ?? 'шт',
            code: '',
            price: it.estimatedPrice,
          })),
        }));

      const status = req.query.status as string | undefined;
      if (status) out = out.filter((x: { status: string }) => x.status === status);
      res.json(pick(out));
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      if (!u.holdingId) {
        res.status(400).json({ error: 'Пользователь не привязан к организации' });
        return;
      }
      const body = req.body ?? {};
      const items = (Array.isArray(body.items) ? body.items : []).map((it: { name?: string; qty?: unknown; price?: unknown; unit?: string }) => ({
        name: String(it.name ?? '').trim(),
        quantity: Number(it.qty) || 0,
        unitPrice: Number(it.price) || 0,
        unit: it.unit ?? null,
      }));
      const created = await createRequest(db, {
        holdingId: u.holdingId,
        requesterId: u.id,
        priority: PRIORITY_BY_URGENCY[body.urgency as string] ?? 'normal',
        title: body.department || body.purpose || undefined,
        description: [body.purpose, body.notes].filter(Boolean).join(' · ') || undefined,
        departmentName: body.department ?? null,
        warehouseName: body.warehouse ?? null,
        neededDate: body.needed_by ? new Date(body.needed_by) : null,
        items,
      });
      res.json({ ok: true, id: created.id, req_number: created.requestNumber });
    } catch (e) {
      next(e);
    }
  });

  r.get('/requests/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const [rq] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!rq) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!canAccessRequest(role, u.id, u.holdingId, rq)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const stepRole = await stepRoleMap();
      const its = await db.select().from(schema.requestItems).where(eq(schema.requestItems.requestId, rq.id));
      const aps = await db.select().from(schema.approvals).where(eq(schema.approvals.requestId, rq.id));
      const approverNames = await namesByIds(aps.map((a: { approverUserId: string | null }) => a.approverUserId as string));

      const approvals = aps.map((a: any) => ({
        status: a.status === 'approved' ? 'approved' : a.status === 'rejected' ? 'rejected' : 'pending',
        approver_name: a.approverUserId ? approverNames.get(a.approverUserId) ?? null : null,
        stage: a.workflowStepId ? stepRole.get(a.workflowStepId) ?? 'pending' : 'pending',
        signed_at: a.approvedAt ?? null,
      }));

      // Audit: request-entity + this request's approval-entity logs, merged & sorted.
      const apIds = aps.map((a: { id: string }) => a.id);
      const reqAudits = await db
        .select()
        .from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.entityType, 'request'), eq(schema.auditLogs.entityId, rq.id)));
      const apAudits = apIds.length
        ? await db
            .select()
            .from(schema.auditLogs)
            .where(and(eq(schema.auditLogs.entityType, 'approval'), inArray(schema.auditLogs.entityId, apIds)))
        : [];
      const allAudits = [...reqAudits, ...apAudits].sort(
        (a: { createdAt: unknown }, b: { createdAt: unknown }) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
      );
      const auditNames = await namesByIds(allAudits.map((l: { userId: string | null }) => l.userId as string));
      const audit_logs = allAudits.map((l: any) => ({
        action: AUDIT_ACTION[l.action] ?? l.action,
        new_value: l.newValue ? (typeof l.newValue === 'string' ? l.newValue : JSON.stringify(l.newValue)) : null,
        user_name: l.userId ? auditNames.get(l.userId) ?? null : null,
        role: l.userRoleSnapshot ?? null,
        source: l.source ?? null,
        created_at: l.createdAt,
      }));

      const [requester] = await db.select().from(schema.users).where(eq(schema.users.id, rq.requesterId));
      const atts = await db.select().from(schema.attachments).where(eq(schema.attachments.requestId, rq.id));
      const quos = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, rq.id));

      res.json({
        id: rq.id,
        req_number: rq.requestNumber,
        status: legacyStatus(rq.status, rq.currentStepId ? stepRole.get(rq.currentStepId) : undefined),
        urgency: URGENCY_BY_PRIORITY[rq.priority] || 'standard',
        department: rq.departmentName ?? '',
        warehouse: rq.warehouseName ?? '',
        purpose: rq.description ?? '',
        needed_by: fmtDate(rq.neededDate),
        total_amount: rq.estimatedAmount,
        created_at: rq.createdAt,
        requester_name: requester ? requester.fullName : '—',
        items: its.map((it: any) => ({ name: it.name, qty: Number(it.quantity), unit: it.unit ?? 'шт', code: '', price: it.estimatedPrice })),
        approvals,
        audit_logs,
        attachments: atts.map((a: any) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, created_at: a.createdAt })),
        quotations: quos
          .sort((a: any, b: any) => Number(b.selected) - Number(a.selected) || a.amount - b.amount)
          .map((q: any) => ({ id: q.id, supplier_name: q.supplierName, amount: q.amount, lead_time: q.leadTime, note: q.note, selected: q.selected })),
      });
    } catch (e) {
      next(e);
    }
  });

  r.get('/approvals', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      const roleRows = await db
        .select({ roleId: schema.userRoles.roleId })
        .from(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, u.id), eq(schema.userRoles.status, 'active')));
      const roleIds = roleRows.map((x: { roleId: string }) => x.roleId);
      if (!roleIds.length) {
        res.json([]);
        return;
      }
      const stepRows = await db
        .select({ id: schema.workflowSteps.id, code: schema.roles.code })
        .from(schema.workflowSteps)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.workflowSteps.approverRoleId))
        .where(inArray(schema.workflowSteps.approverRoleId, roleIds));
      const stepCode = new Map<string, string>(stepRows.map((s: { id: string; code: string }) => [s.id, s.code]));
      const stepIds = stepRows.map((s: { id: string }) => s.id);
      if (!stepIds.length) {
        res.json([]);
        return;
      }
      const pend = await db
        .select()
        .from(schema.approvals)
        .where(and(inArray(schema.approvals.workflowStepId, stepIds), eq(schema.approvals.status, 'pending')));
      const reqIds = [...new Set(pend.map((p: { requestId: string }) => p.requestId))] as string[];
      const reqs = reqIds.length ? await db.select().from(schema.requests).where(inArray(schema.requests.id, reqIds)) : [];
      const reqById = new Map<string, any>(reqs.map((x: any) => [x.id, x]));
      const requesterNames = await namesByIds(reqs.map((x: any) => x.requesterId));
      const apItems = reqIds.length
        ? await db.select().from(schema.requestItems).where(inArray(schema.requestItems.requestId, reqIds))
        : [];
      const itemsByReq = new Map<string, any[]>();
      for (const it of apItems as any[]) {
        if (!itemsByReq.has(it.requestId)) itemsByReq.set(it.requestId, []);
        itemsByReq.get(it.requestId)!.push(it);
      }

      const out = pend
        .filter((p: { requestId: string }) => reqById.get(p.requestId)?.holdingId === u.holdingId)
        .map((p: any) => {
          const rq = reqById.get(p.requestId);
          return {
            id: p.id,
            req_db_id: rq.id,
            req_number: rq.requestNumber,
            stage: p.workflowStepId ? stepCode.get(p.workflowStepId) ?? 'pending' : 'pending',
            department: rq.departmentName ?? '',
            requester_name: requesterNames.get(rq.requesterId) ?? '—',
            total_amount: rq.estimatedAmount,
            purpose: rq.description ?? '',
            needed_by: fmtDate(rq.neededDate),
            urgency: URGENCY_BY_PRIORITY[rq.priority] || 'standard',
            warehouse: rq.warehouseName ?? '',
            items: (itemsByReq.get(rq.id) ?? []).map((it: any) => ({
              name: it.name,
              qty: Number(it.quantity),
              unit: it.unit ?? 'шт',
              code: '',
              price: it.estimatedPrice,
            })),
          };
        });
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/approvals/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const body = req.body ?? {};
      const approvalId = req.params.id as string;

      // R2: same permission gate as the canonical route — the step-role check
      // inside the service alone is not an authorization to approve.
      if (!u.holdingId || !(await hasPermission(db, u.id, 'approvals.approve', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Недостаточно прав для согласования' });
        return;
      }

      // P1-2: an approval is a signature — require a valid PIN ALWAYS, for every
      // role, exactly like the canonical route. (The old code only asked money-stage
      // roles for a PIN, so a custom-role approval was signed without one.)
      const [usr] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      if (!usr?.pinHash) {
        res.status(403).json({ error: 'PIN не задан — задайте PIN в настройках для подписи' });
        return;
      }
      const lockMsApprove = pinLockoutRemaining(u.id);
      if (lockMsApprove > 0) { res.status(403).json({ error: `PIN locked, retry in ${Math.ceil(lockMsApprove / 60000)} min` }); return; }
      if (!verifyPin(body.pin, usr.pinHash)) {
        const lockedApprove = recordPinFailure(u.id);
        res.status(403).json({ error: lockedApprove ? 'Too many attempts — locked 15 min' : 'Wrong PIN' }); return;
      }
      clearPinFailures(u.id);

      const result = await approveApproval(db, {
        approvalId,
        actorUserId: u.id,
        comment: body.comment,
      });
      res.json({ ok: true, next_stage: result.nextStepId, closed: result.status === 'approved' });
    } catch (e) {
      next(e);
    }
  });

  r.post('/auth/set-pin', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const pin = String((req.body ?? {}).pin ?? '');
      if (!/^\d{6}$/.test(pin)) {
        res.status(400).json({ error: 'PIN must be 6 digits' });
        return;
      }
      await db.update(schema.users).set({ pinHash: hashPin(pin) }).where(eq(schema.users.id, u.id));
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests/:id/override', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const b = req.body ?? {};
      // Override is gated by the dedicated permission from the catalog (owner
      // holds 'all'), so re-mapping roles in the constructor actually applies —
      // this also puts the previously-dead approvals.override to work (M5).
      if (!u.holdingId || !(await hasPermission(db, u.id, 'approvals.override', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Только учредитель (approvals.override)' });
        return;
      }
      if (!['approve', 'cancel'].includes(b.action)) {
        res.status(400).json({ error: 'action: approve | cancel' });
        return;
      }
      if (!String(b.reason ?? '').trim()) {
        res.status(400).json({ error: 'Причина обязательна' });
        return;
      }
      const [usr] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      if (!usr?.pinHash) {
        res.status(403).json({ error: 'PIN не задан — задайте PIN в настройках' });
        return;
      }
      const lockMsOverride = pinLockoutRemaining(u.id);
      if (lockMsOverride > 0) { res.status(403).json({ error: `PIN locked, retry in ${Math.ceil(lockMsOverride/60000)} min` }); return; }
      if (!verifyPin(b.pin, usr.pinHash)) {
        const lockedOverride = recordPinFailure(u.id);
        res.status(403).json({ error: lockedOverride ? 'Too many attempts — locked 15 min' : 'Wrong PIN' }); return;
      }
      clearPinFailures(u.id);
      const [rq] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!rq) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (rq.holdingId !== u.holdingId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (isTerminalStatus(rq.status)) {
        res.status(400).json({ error: 'Заявка уже завершена' });
        return;
      }
      const newStatus = b.action === 'approve' ? 'approved' : 'rejected';
      await db.transaction(async (tx: Db) => {
        await tx
          .update(schema.approvals)
          .set({
            status: b.action === 'approve' ? 'approved' : 'rejected',
            approverUserId: u.id,
            comment: 'OWNER OVERRIDE: ' + String(b.reason).trim(),
            approvedAt: new Date(),
          })
          .where(and(eq(schema.approvals.requestId, rq.id), eq(schema.approvals.status, 'pending')));
        await tx
          .update(schema.requests)
          .set({ status: newStatus, currentStepId: null, updatedAt: new Date(), closedAt: new Date() })
          .where(eq(schema.requests.id, rq.id));
        // E5: every transition writes status history — the legacy layer included.
        await tx.insert(schema.requestStatusHistory).values({
          requestId: rq.id,
          oldStatus: rq.status,
          newStatus,
          changedBy: u.id,
          comment: 'OWNER OVERRIDE: ' + String(b.reason).trim(),
          source: 'api',
        });
        await tx.insert(schema.auditLogs).values({
          holdingId: rq.holdingId,
          userId: u.id,
          action: 'OWNER_OVERRIDE',
          module: 'approvals',
          entityType: 'request',
          entityId: rq.id,
          newValue: { action: b.action, reason: String(b.reason).trim() },
          source: 'api',
        });
      });
      res.json({ ok: true, status: newStatus });
    } catch (e) {
      next(e);
    }
  });

  // ── Admin / constructor (design contract) ──────────────────────────────────

  r.post('/approvals/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const body = req.body ?? {};
      // R3: mirror the canonical route's permission gate.
      if (!u.holdingId || !(await hasPermission(db, u.id, 'approvals.reject', { holdingId: u.holdingId }))) {
        res.status(403).json({ error: 'Недостаточно прав для отклонения' });
        return;
      }
      await rejectApproval(db, { approvalId: req.params.id as string, actorUserId: u.id, comment: body.comment ?? '' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/auth/verify-pin', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const [usr] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
      if (!usr?.pinHash) {
        res.json({ ok: true, no_pin: true });
        return;
      }
      const lockMsVerify = pinLockoutRemaining(u.id);
      if (lockMsVerify > 0) { res.status(403).json({ error: `PIN locked, retry in ${Math.ceil(lockMsVerify/60000)} min` }); return; }
      const pinOk = verifyPin(String((req.body ?? {}).pin ?? ''), usr.pinHash);
      if (!pinOk) {
        const lockedVerify = recordPinFailure(u.id);
        res.status(403).json({ error: lockedVerify ? 'Too many attempts — locked 15 min' : 'Wrong PIN' }); return;
      }
      clearPinFailures(u.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ── Quotations (КП) ─────────────────────────────────────────────────────────
  r.get('/requests/:id/quotations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const [rqQ] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      const roleQ = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!rqQ || !canAccessRequest(roleQ, u.id, u.holdingId, rqQ)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db.select().from(schema.quotations).where(eq(schema.quotations.requestId, req.params.id as string));
      res.json(
        rows
          .sort((a: any, b: any) => Number(b.selected) - Number(a.selected) || a.amount - b.amount)
          .map((q: any) => ({ id: q.id, supplier_name: q.supplierName, amount: q.amount, lead_time: q.leadTime, note: q.note, selected: q.selected })),
      );
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests/:id/quotations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!['procurement', 'owner', 'admin', 'director'].includes(role)) {
        res.status(403).json({ error: 'Только снабжение' });
        return;
      }
      const b = req.body ?? {};
      if (!String(b.supplier_name ?? '').trim()) {
        res.status(400).json({ error: 'Укажите поставщика' });
        return;
      }
      const amt = Math.round(Number(b.amount));
      if (!Number.isFinite(amt) || amt < 0) {
        res.status(400).json({ error: 'Сумма КП должна быть неотрицательным числом' });
        return;
      }
      const [rq] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!rq) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (rq.holdingId !== u.holdingId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const q = await db.transaction(async (tx: Db) => {
        const [row] = await tx
          .insert(schema.quotations)
          .values({
            holdingId: rq.holdingId,
            requestId: rq.id,
            supplierName: String(b.supplier_name).trim(),
            amount: amt,
            leadTime: b.lead_time ?? null,
            note: b.note ?? null,
            createdBy: u.id,
          })
          .returning();
        // E5: mirror the canonical layer's audit for КП.
        await tx.insert(schema.auditLogs).values({
          holdingId: rq.holdingId,
          factoryId: rq.factoryId,
          userId: u.id,
          action: 'quotation.created',
          module: 'procurement',
          entityType: 'quotation',
          entityId: row.id,
          newValue: { supplierName: row.supplierName, amount: amt },
          source: 'api',
        });
        return row;
      });
      res.json({ ok: true, id: q.id });
    } catch (e) {
      next(e);
    }
  });

  r.patch('/quotations/:id/select', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!['procurement', 'owner', 'admin', 'director'].includes(role)) {
        res.status(403).json({ error: 'Только снабжение' });
        return;
      }
      const [q] = await db.select().from(schema.quotations).where(eq(schema.quotations.id, req.params.id as string));
      if (!q) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const [rqS] = await db.select().from(schema.requests).where(eq(schema.requests.id, q.requestId));
      if (!rqS || rqS.holdingId !== u.holdingId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (isTerminalStatus(rqS.status)) {
        res.status(409).json({ error: 'Заявка завершена — сумму менять нельзя' });
        return;
      }
      // P1-4: a supplier/quotation may only be selected while the request is on a
      // procurement step — BEFORE any threshold approval. Changing the amount after
      // approval would let a pricier КП slip past the financial control that already
      // ran. After approval this requires a re-approval flow, not a silent edit.
      const [curStep] = rqS.currentStepId
        ? await db.select().from(schema.workflowSteps).where(eq(schema.workflowSteps.id, rqS.currentStepId))
        : [undefined];
      if (!curStep || curStep.stepKind !== 'procurement') {
        res.status(409).json({ error: 'REAPPROVAL_REQUIRED: выбрать поставщика можно только на шаге закупки (до согласования)' });
        return;
      }
      await db.transaction(async (tx: Db) => {
        await tx.update(schema.quotations).set({ selected: false }).where(eq(schema.quotations.requestId, q.requestId));
        await tx.update(schema.quotations).set({ selected: true }).where(eq(schema.quotations.id, q.id));
        await tx.update(schema.requests).set({ estimatedAmount: q.amount, updatedAt: new Date() }).where(eq(schema.requests.id, q.requestId));
        // E5: supplier selection changes the request amount — audit it like the canonical layer.
        await tx.insert(schema.auditLogs).values({
          holdingId: rqS.holdingId,
          factoryId: rqS.factoryId,
          userId: u.id,
          action: 'supplier.selected',
          module: 'procurement',
          entityType: 'quotation',
          entityId: q.id,
          newValue: { supplierName: q.supplierName, amount: q.amount },
          source: 'api',
        });
      });
      res.json({ ok: true, total_amount: q.amount });
    } catch (e) {
      next(e);
    }
  });

  // ── Attachments ──────────────────────────────────────────────────────────────
  const MAX_ATTACH = 2 * 1024 * 1024;

  r.get('/requests/:id/attachments', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const [rqA] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      const roleA = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!rqA || !canAccessRequest(roleA, u.id, u.holdingId, rqA)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db.select().from(schema.attachments).where(eq(schema.attachments.requestId, req.params.id as string));
      res.json(rows.map((a: any) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, created_at: a.createdAt })));
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests/:id/attachments', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      if (!u.holdingId) {
        res.status(400).json({ error: 'Нет организации' });
        return;
      }
      const b = req.body ?? {};
      if (!b.filename || !b.data_base64) {
        res.status(400).json({ error: 'filename и data_base64 обязательны' });
        return;
      }
      const [rqAtt] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!rqAtt || rqAtt.holdingId !== u.holdingId) { res.status(403).json({ error: 'Forbidden' }); return; }
      const roleAtt = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!canAccessRequest(roleAtt, u.id, u.holdingId, rqAtt)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const buf = Buffer.from(String(b.data_base64), 'base64');
      if (!buf.length) {
        res.status(400).json({ error: 'Пустой файл' });
        return;
      }
      if (buf.length > MAX_ATTACH) {
        res.status(413).json({ error: 'Файл больше 2 МБ' });
        return;
      }
      const [a] = await db
        .insert(schema.attachments)
        .values({
          holdingId: u.holdingId,
          requestId: req.params.id as string,
          uploaderId: u.id,
          filename: String(b.filename).slice(0, 200),
          mime: b.mime || 'application/octet-stream',
          size: buf.length,
          dataBase64: String(b.data_base64),
        })
        .returning();
      res.json({ ok: true, id: a.id });
    } catch (e) {
      next(e);
    }
  });

  r.get('/attachments/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const [a] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, req.params.id as string));
      if (!a) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const [rqA] = await db.select().from(schema.requests).where(eq(schema.requests.id, a.requestId));
      const roleA = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!rqA || !canAccessRequest(roleA, u.id, u.holdingId, rqA)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const buf = Buffer.from(a.dataBase64 || '', 'base64');
      const SAFE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      const inlineOk = SAFE.includes(a.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', inlineOk ? a.mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `${inlineOk ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.filename)}"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  // ── Warehouse ────────────────────────────────────────────────────────────────
  async function defaultWarehouseId(holdingId: string): Promise<string | null> {
    const [w] = await db.select().from(schema.warehouses).where(eq(schema.warehouses.holdingId, holdingId));
    return w?.id ?? null;
  }

  r.get('/warehouse/stock', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      if (!u.holdingId) {
        res.json([]);
        return;
      }
      // R1: stock levels are not public within the holding. Keep the design's
      // staff roles working, but require warehouse.view from everyone else.
      const stockRole = await primaryRole(db, u.id);
      if (
        !['owner', 'admin', 'director', 'warehouse'].includes(stockRole) &&
        !(await hasPermission(db, u.id, 'warehouse.view', { holdingId: u.holdingId }))
      ) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const rows = await db
        .select({
          materialId: schema.stockBalances.materialId,
          available: schema.stockBalances.availableQty,
          reserved: schema.stockBalances.reservedQty,
          minQty: schema.stockBalances.minQty,
          name: schema.materials.name,
          unit: schema.materials.defaultUnit,
          warehouse: schema.warehouses.name,
        })
        .from(schema.stockBalances)
        .innerJoin(schema.materials, eq(schema.materials.id, schema.stockBalances.materialId))
        .leftJoin(schema.warehouses, eq(schema.warehouses.id, schema.stockBalances.warehouseId))
        .where(eq(schema.stockBalances.holdingId, u.holdingId));
      const search = String(req.query.search ?? '').toLowerCase();
      const out = rows
        .filter((x: any) => !search || String(x.name).toLowerCase().includes(search))
        .map((x: any) => {
          const qty = Number(x.available);
          const minQty = Number(x.minQty);
          return {
            material_id: x.materialId,
            name: x.name,
            code: '',
            unit: x.unit ?? '',
            category: '',
            warehouse: x.warehouse ?? 'Склад',
            qty,
            reserved_qty: Number(x.reserved),
            min_qty: minQty,
            available: qty - Number(x.reserved),
            low: minQty > 0 && qty <= minQty,
            critical: minQty > 0 && qty <= minQty * 0.5,
          };
        });
      res.json(out.slice(0, 50));
    } catch (e) {
      next(e);
    }
  });

  r.post('/warehouse/receive', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!['warehouse', 'director', 'owner', 'admin'].includes(role)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const b = req.body ?? {};
      if (!b.material_id || !b.qty) {
        res.status(400).json({ error: 'Missing fields' });
        return;
      }
      const wid = await defaultWarehouseId(u.holdingId as string);
      const result = await receiveStock(db, {
        holdingId: u.holdingId as string,
        materialId: String(b.material_id),
        warehouseId: wid,
        quantity: Number(b.qty),
        performedBy: u.id,
      });
      res.json({ ok: true, available: result.availableQty });
    } catch (e) {
      next(e);
    }
  });

  r.post('/requests/:id/receive-close', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const role = u.holdingId ? await primaryRole(db, u.id) : 'requester';
      if (!['warehouse', 'director', 'owner', 'admin'].includes(role)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const [rq] = await db.select().from(schema.requests).where(eq(schema.requests.id, req.params.id as string));
      if (!rq) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (rq.holdingId !== u.holdingId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      // Receiving closes a request only AFTER it cleared the approval chain.
      // Without this gate any warehouse user could "close" a draft/pending request,
      // bypassing every approval and PIN signature (spend-authorization bypass).
      if (rq.status !== 'approved') {
        res.status(409).json({ error: 'Заявка ещё не прошла согласование' });
        return;
      }
      await db.transaction(async (tx: Db) => {
        await tx
          .update(schema.requests)
          .set({ status: 'closed', currentStepId: null, updatedAt: new Date(), closedAt: new Date() })
          .where(eq(schema.requests.id, rq.id));
        // E5: legacy receive-close also leaves a history row.
        await tx.insert(schema.requestStatusHistory).values({
          requestId: rq.id,
          oldStatus: rq.status,
          newStatus: 'closed',
          changedBy: u.id,
          source: 'api',
        });
        await tx.insert(schema.auditLogs).values({
          holdingId: rq.holdingId,
          userId: u.id,
          action: 'RECEIVE_CLOSE',
          module: 'warehouse',
          entityType: 'request',
          entityId: rq.id,
          newValue: { status: 'closed' },
          source: 'api',
        });
      });
      res.json({ ok: true, status: 'closed' });
    } catch (e) {
      next(e);
    }
  });

  r.post('/dev/set-my-role', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = (req as AuthedReq).dbUser;
      const role = (req.body ?? {}).role;
      const valid = ['requester', 'dept_head', 'warehouse', 'procurement', 'finance', 'director', 'owner', 'admin'];
      // Dev/preview only: actually switch the user's role so the Telegram role
      // switcher works for a single real account. Inert in production.
      if (devAuth && u.holdingId && valid.includes(role)) {
        await setSingleRole(u.id, u.holdingId, role);
      }
      res.json({ ok: true, role });
    } catch (e) {
      next(e);
    }
  });

  // ── Admin / constructor (design contract) ──────────────────────────────────
  const ROLE_PRIO = ['owner', 'director', 'admin', 'finance', 'procurement', 'warehouse', 'dept_head', 'requester'];

  // Admin access is gated by GRANULAR PERMISSIONS from the constructor catalog, not by
  // role names — so re-mapping role→permissions in the admin actually changes who can do
  // what (with role names the whole permission catalog was dead in the live API).
  async function requirePerm(
    req: Request,
    res: Response,
    code: string,
  ): Promise<{ id: string; holdingId: string } | null> {
    const u = (req as AuthedReq).dbUser;
    if (!u.holdingId || !(await hasPermission(db, u.id, code, { holdingId: u.holdingId }))) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return { id: u.id, holdingId: u.holdingId };
  }

  function canAssignRole(actorRole: string, targetRole: string): boolean {
    if (actorRole === 'owner') return true;
    return !['owner', 'director', 'admin'].includes(targetRole);
  }

  async function roleByCode(code: string, holdingId: string): Promise<{ id: string } | null> {
    const rows = await db.select().from(schema.roles).where(eq(schema.roles.code, code));
    // Prefer the system role (holdingId null), then this holding's role.
    const r0 = rows.find((r: any) => r.holdingId === null) ?? rows.find((r: any) => r.holdingId === holdingId) ?? rows[0];
    return r0 ? { id: r0.id } : null;
  }

  /** Resolve a role id by code, preferring the system role (holdingId null). */
  async function roleIdByCode(code: string): Promise<string | null> {
    const rows = await db.select().from(schema.roles).where(eq(schema.roles.code, code));
    const r0 = rows.find((r: any) => r.holdingId === null) ?? rows[0];
    return r0?.id ?? null;
  }

  /**
   * P1-3: a user cannot grant a role whose permission set exceeds their own — this
   * mirrors the canonical admin's anti-escalation guard, which the legacy name-based
   * `canAssignRole` bypassed (a plain users.manage holder could hand out `finance`).
   */
  async function canGrantRole(actorId: string, holdingId: string, roleCode: string): Promise<boolean> {
    const actorCodes = new Set(await getUserPermissionCodes(db, actorId));
    const role = await roleByCode(roleCode, holdingId);
    if (!role) return false;
    const targetCodes: { code: string }[] = await db
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(eq(schema.rolePermissions.roleId, role.id));
    return targetCodes.every((p) => actorCodes.has(p.code));
  }

  /**
   * P1-3: assign a single role WITHOUT hard-deleting assignment history. Existing
   * active roles are revoked (status='revoked'), then the new role is added active.
   */
  async function setSingleRole(userId: string, holdingId: string, code: string): Promise<void> {
    const role = await roleByCode(code, holdingId);
    if (!role) return;
    await db
      .update(schema.userRoles)
      .set({ status: 'revoked' })
      .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.status, 'active')));
    await db.insert(schema.userRoles).values({ userId, roleId: role.id, holdingId, status: 'active' });
  }

  async function activeWorkflow(holdingId: string) {
    // Deterministic pick (oldest active) so the admin edits and the engine route by the
    // SAME workflow even if more than one is ever marked active.
    const [wf] = await db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.holdingId, holdingId), eq(schema.workflows.isActive, true)))
      .orderBy(schema.workflows.createdAt);
    return wf ?? null;
  }

  r.get('/admin/users', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'users.view');
      if (!ctx) return;
      const us = await db.select().from(schema.users).where(eq(schema.users.holdingId, ctx.holdingId));
      const urs = await db
        .select({ userId: schema.userRoles.userId, code: schema.roles.code })
        .from(schema.userRoles)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
        .where(and(eq(schema.userRoles.status, 'active'), eq(schema.userRoles.holdingId, ctx.holdingId)));
      const byUser = new Map<string, string[]>();
      for (const x of urs as { userId: string; code: string }[]) {
        if (!byUser.has(x.userId)) byUser.set(x.userId, []);
        byUser.get(x.userId)!.push(x.code);
      }
      const out = us.map((u: any) => {
        const codes = byUser.get(u.id) ?? [];
        const [first, ...rest] = (u.fullName || '').split(' ');
        return {
          id: u.id,
          telegram_id: u.telegramId,
          first_name: first || u.fullName,
          last_name: rest.join(' '),
          username: null,
          role: ROLE_PRIO.find((c) => codes.includes(c)) ?? codes[0] ?? 'requester',
          active: u.status === 'disabled' ? 0 : 1,
          created_at: u.createdAt,
        };
      });
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.post('/admin/users', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'users.manage');
      if (!ctx) return;
      const actorRole = await primaryRole(db, ctx.id);
      const b = req.body ?? {};
      if (!b.telegram_id || !b.first_name) {
        res.status(400).json({ error: 'Missing fields' });
        return;
      }
      const role = b.role || 'requester';
      if (!canAssignRole(actorRole, role) || !(await canGrantRole(ctx.id, ctx.holdingId, role))) {
        res.status(403).json({ error: 'Недостаточно прав для назначения этой роли' });
        return;
      }
      const fullName = [b.first_name, b.last_name].filter(Boolean).join(' ');
      try {
        const [u] = await db
          .insert(schema.users)
          .values({ telegramId: String(b.telegram_id), fullName, holdingId: ctx.holdingId, status: 'active' })
          .returning();
        await setSingleRole(u.id, ctx.holdingId, role);
        res.json({ ok: true, id: u.id });
      } catch {
        res.status(400).json({ error: 'telegram_id already exists' });
      }
    } catch (e) {
      next(e);
    }
  });

  r.patch('/admin/users/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'users.manage');
      if (!ctx) return;
      const [target] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id as string));
      if (!target || target.holdingId !== ctx.holdingId) { res.status(404).json({ error: 'User not found' }); return; }
      const actorRole = await primaryRole(db, ctx.id);
      const b = req.body ?? {};
      const updates: Record<string, unknown> = {};
      if (b.first_name !== undefined || b.last_name !== undefined) {
        updates.fullName = [b.first_name ?? '', b.last_name ?? ''].join(' ').trim();
      }
      if (Object.keys(updates).length) {
        await db.update(schema.users).set(updates).where(eq(schema.users.id, req.params.id as string));
      }
      if (b.role) {
        if (!canAssignRole(actorRole, b.role) || !(await canGrantRole(ctx.id, ctx.holdingId, b.role))) {
          res.status(403).json({ error: 'Недостаточно прав для назначения этой роли' });
          return;
        }
        await setSingleRole(req.params.id as string, ctx.holdingId, b.role);
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.delete('/admin/users/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'users.manage');
      if (!ctx) return;
      if ((req.params.id as string) === ctx.id) {
        res.status(400).json({ error: 'Нельзя деактивировать себя' });
        return;
      }
      const [targetDel] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id as string));
      if (!targetDel || targetDel.holdingId !== ctx.holdingId) { res.status(404).json({ error: 'User not found' }); return; }
      await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, req.params.id as string));
      res.json({ ok: true, active: 0 });
    } catch (e) {
      next(e);
    }
  });

  r.post('/admin/users/:id/activate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'users.manage');
      if (!ctx) return;
      const [targetAct] = await db.select().from(schema.users).where(eq(schema.users.id, req.params.id as string));
      if (!targetAct || targetAct.holdingId !== ctx.holdingId) { res.status(404).json({ error: 'User not found' }); return; }
      await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, req.params.id as string));
      res.json({ ok: true, active: 1 });
    } catch (e) {
      next(e);
    }
  });

  r.get('/admin/settings', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'settings.manage');
      if (!ctx) return;
      const rows = await db.select().from(schema.settings).where(eq(schema.settings.holdingId, ctx.holdingId));
      const out: Record<string, string> = {};
      for (const s of rows as { key: string; value: string | null }[]) out[s.key] = s.value ?? '';
      // Surface the LIVE approval thresholds (they live on workflow steps — what the engine
      // actually routes by) so the design's threshold fields reflect reality, not a dead setting.
      const wfS = await activeWorkflow(ctx.holdingId);
      if (wfS) {
        const tsteps = await db
          .select({ code: schema.roles.code, threshold: schema.workflowSteps.thresholdAmount })
          .from(schema.workflowSteps)
          .innerJoin(schema.roles, eq(schema.roles.id, schema.workflowSteps.approverRoleId))
          .where(eq(schema.workflowSteps.workflowId, wfS.id));
        const thr = new Map<string, unknown>(tsteps.map((s: any) => [s.code, s.threshold]));
        out.amount_threshold_deputy = thr.get('finance') != null ? String(thr.get('finance')) : '';
        out.amount_threshold_director = thr.get('director') != null ? String(thr.get('director')) : '';
        out.amount_threshold_owner = thr.get('owner') != null ? String(thr.get('owner')) : '';
      }
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.put('/admin/settings', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'settings.manage');
      if (!ctx) return;
      // The design's threshold fields must drive the ENGINE, so route them to the matching
      // workflow step's threshold (deputy→finance, director→director, owner→owner) instead of
      // a settings row the engine never reads.
      const THRESHOLD_STEP: Record<string, string> = {
        amount_threshold_deputy: 'finance',
        amount_threshold_director: 'director',
        amount_threshold_owner: 'owner',
      };
      const wfT = await activeWorkflow(ctx.holdingId);
      for (const [key, value] of Object.entries(req.body ?? {})) {
        const stepCode = THRESHOLD_STEP[key];
        if (stepCode) {
          const amt = Math.round(Number(value));
          if (wfT && Number.isFinite(amt) && amt >= 0) {
            const rid = await roleIdByCode(stepCode);
            if (rid) {
              await db
                .update(schema.workflowSteps)
                .set({ thresholdAmount: amt })
                .where(and(eq(schema.workflowSteps.workflowId, wfT.id), eq(schema.workflowSteps.approverRoleId, rid)));
            }
          }
          continue;
        }
        const existing = await db
          .select()
          .from(schema.settings)
          .where(and(eq(schema.settings.holdingId, ctx.holdingId), eq(schema.settings.key, key)));
        if (existing.length) {
          await db.update(schema.settings).set({ value: String(value), updatedAt: new Date() }).where(eq(schema.settings.id, existing[0].id));
        } else {
          await db.insert(schema.settings).values({ holdingId: ctx.holdingId, key, value: String(value) });
        }
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.get('/admin/workflow', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'workflows.manage');
      if (!ctx) return;
      const wf = await activeWorkflow(ctx.holdingId);
      if (!wf) {
        res.json([]);
        return;
      }
      const steps = await db
        .select({
          id: schema.workflowSteps.id,
          label: schema.workflowSteps.stepName,
          order_num: schema.workflowSteps.stepOrder,
          enabled: schema.workflowSteps.enabled,
          code: schema.roles.code,
        })
        .from(schema.workflowSteps)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.workflowSteps.approverRoleId))
        .where(eq(schema.workflowSteps.workflowId, wf.id));
      const out = steps
        .sort((a: { order_num: number }, b: { order_num: number }) => a.order_num - b.order_num)
        .map((s: { label: string; order_num: number; enabled: boolean; code: string }) => ({
          stage_key: s.code,
          label: s.label,
          order_num: s.order_num,
          enabled: s.enabled ? 1 : 0,
          approver_role: s.code,
        }));
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.patch('/admin/workflow/:key', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await requirePerm(req, res, 'workflows.manage');
      if (!ctx) return;
      const wf = await activeWorkflow(ctx.holdingId);
      if (!wf) {
        res.status(404).json({ error: 'No workflow' });
        return;
      }
      const rid = await roleIdByCode(req.params.key as string);
      if (rid && req.body?.enabled !== undefined) {
        await db
          .update(schema.workflowSteps)
          .set({ enabled: Boolean(req.body.enabled) })
          .where(and(eq(schema.workflowSteps.workflowId, wf.id), eq(schema.workflowSteps.approverRoleId, rid)));
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
