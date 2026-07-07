/**
 * QA-прогон 2026-07-07, класс «ошибки конкурентности»: двойной сабмит одного
 * действия (двойной клик, ретрай сети) не должен продвинуть заявку на два шага
 * и не должен оставить два approved-решения на одном шаге.
 * performAction сериализуется через SELECT ... FOR UPDATE.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from './request.service.js';
import { performAction } from './lifecycle.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  await seedSystemRolesAndPermissions(db);
  const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
  await db.insert(schema.settings).values({ holdingId: h.id, key: 'require_pin', value: '0' });
  const roleId = async (code: string): Promise<string> => {
    const [r] = await db.select().from(schema.roles).where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    return r.id;
  };
  const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
  await db.insert(schema.workflowSteps).values([
    { workflowId: wf.id, stepOrder: 1, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId('director') },
    { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId('requester') },
  ]);
  const user = async (code: string, tg: string): Promise<string> => {
    const [u] = await db.insert(schema.users).values({ holdingId: h.id, fullName: tg, telegramId: tg, status: 'active' }).returning();
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(code), holdingId: h.id });
    return u.id;
  };
  return { db, h, f, user };
}

describe('конкурентность performAction', () => {
  it('двойной сабмит approve: заявка продвигается ровно на один шаг, решение одно', async () => {
    const { db, h, f, user } = await setup();
    const requester = await user('requester', 'author');
    const dir = await user('director', 'dir');
    const r = await createRequest(db, { holdingId: h.id, requesterId: requester, factoryId: f.id, items: [{ name: 'X', quantity: 1, unitPrice: 5 }] });

    const attempt = () => performAction(db, { requestId: r.id, action: 'approve', actor: { id: dir, holdingId: h.id } });
    const results = await Promise.allSettled([attempt(), attempt()]);

    // Минимум один успех; второй либо упал (шаг уже другой), либо сериализовался
    // после первого и обязан был упасть — двух успехов быть не может.
    const ok = results.filter((x) => x.status === 'fulfilled').length;
    expect(ok).toBe(1);

    const [after] = await db.select().from(schema.requests).where(eq(schema.requests.id, r.id));
    expect(after.status).toBe('close'); // ровно шаг 2, не терминальный «перескок»

    const approved = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.requestId, r.id), eq(schema.approvals.status, 'approved')));
    expect(approved).toHaveLength(1); // одно подписанное решение, не два
  });
});
