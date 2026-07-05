/**
 * Регресс LIMIT-100: инбокс «Ожидают меня» обязан находить заявку, даже когда
 * открытых заявок в холдинге сильно больше сотни и нужная — самая старая.
 * Раньше грузились 100 новейших и фильтровались после, поэтому заявка,
 * ждущая согласующего, «исчезала». Теперь кандидаты отбираются в SQL
 * (inboxCandidates), и KPI дашборда считается тем же хелпером.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { seedSystemRolesAndPermissions } from '../db/seed.js';
import { createRequest } from '../services/request.service.js';
import { inboxCandidates, availableActions } from '../services/lifecycle.service.js';
import { getDashboard } from '../services/dashboard.service.js';
import { hashPin } from '../auth/pin.js';

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
    .values({ holdingId, fullName: tg, telegramId: tg, status: 'active', pinHash: hashPin('1234') })
    .returning();
  for (const code of roleCodes) {
    await db.insert(schema.userRoles).values({ userId: u.id, roleId: await roleId(db, code), holdingId });
  }
  return u.id;
}

describe('инбокс при >100 открытых заявок', () => {
  it('согласующий видит свою заявку, даже если она старейшая из 120; KPI совпадает', async () => {
    const db = await setup();
    const [h] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
    const [f] = await db.insert(schema.factories).values({ holdingId: h.id, name: 'F' }).returning();
    const requester = await mkUser(db, h.id, ['requester'], 'req');
    const director = await mkUser(db, h.id, ['director'], 'dir');

    // Двухшаговый маршрут: 1 — директор, 2 — закрытие автором.
    const [wf] = await db.insert(schema.workflows).values({ holdingId: h.id, name: 'W', isActive: true }).returning();
    await db.insert(schema.workflowSteps).values([
      { workflowId: wf.id, stepOrder: 1, stepName: 'Директор', stepKind: 'approval', approverRoleId: await roleId(db, 'director') },
      { workflowId: wf.id, stepOrder: 2, stepName: 'Закрытие', stepKind: 'close', approverRoleId: await roleId(db, 'requester') },
    ]);

    // Самая старая заявка — та, что ждёт директора.
    const target = await createRequest(db, {
      holdingId: h.id,
      requesterId: requester,
      factoryId: f.id,
      title: 'ЦЕЛЬ: ждёт директора',
      items: [{ name: 'X', quantity: 1, unitPrice: 100 }],
    });
    // Затем 120 «шумовых» открытых заявок новее целевой (тоже ждут директора,
    // но проверяем именно что старейшая НЕ выпала из выборки).
    for (let i = 0; i < 120; i++) {
      await createRequest(db, {
        holdingId: h.id,
        requesterId: requester,
        factoryId: f.id,
        title: `шум ${i}`,
        items: [{ name: 'Y', quantity: 1, unitPrice: 50 }],
      });
    }

    const cand = await inboxCandidates(db, director, h.id);
    expect(cand.length).toBe(121); // все ждут директора — ни одна не отсечена лимитом
    expect(cand.some((r: any) => r.id === target.id)).toBe(true);

    // Финальный судья пропускает целевую заявку.
    const targetRow = cand.find((r: any) => r.id === target.id)!;
    expect((await availableActions(db, targetRow, director)).map((a) => a.action)).toContain('approve');

    // KPI «Ожидают меня» использует тот же префильтр — 121, а не max 100.
    const dash = await getDashboard(db, director, h.id);
    expect(dash.pendingForMe).toBe(121);

    // Заявитель не видит чужие шаги: его инбокс пуст (close ещё не наступил).
    expect((await inboxCandidates(db, requester, h.id)).length).toBe(0);
  }, 120_000);
});
