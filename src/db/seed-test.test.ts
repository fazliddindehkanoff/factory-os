/** seed:test — idempotence and the shape the multi-window QA mode relies on. */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';
import { seedTest, TEST_USERS, TEST_PIN } from './seed-test.js';
import { performAction, availableActions } from '../services/lifecycle.service.js';

async function makeDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('seedTest', () => {
  it('is idempotent and creates users, workflow and sample requests', async () => {
    const db = await makeDb();
    const first = await seedTest(db);
    const second = await seedTest(db); // re-run must not duplicate anything

    expect(second.holding.id).toBe(first.holding.id);
    const users = await db.select().from(schema.users);
    expect(users.length).toBe(TEST_USERS.length);

    const steps = await db
      .select()
      .from(schema.workflowSteps)
      .where(eq(schema.workflowSteps.workflowId, first.workflow.id));
    expect(steps.length).toBe(9);

    const requests = await db.select().from(schema.requests);
    expect(requests.length).toBe(3);
    const statuses = requests.map((r: any) => r.status).sort();
    expect(statuses).toEqual(['pending_approval', 'procurement', 'rejected']);
  });

  it('walks the full ТЗ scenario end-to-end with the seeded users', async () => {
    const db = await makeDb();
    const { users, holding, requests } = await seedTest(db);
    const act = (userKey: string, requestId: string, action: string, extra: Record<string, unknown> = {}) =>
      performAction(db, {
        requestId,
        action,
        actor: { id: users[userKey].id, holdingId: holding.id },
        pin: TEST_PIN,
        ...extra,
      });

    // Fresh request sits with the warehouse head; then follows the ТЗ path.
    // №16б: перед шагом закупки согласование = «Передать снабженцу».
    const id = requests.fresh.id;
    await act('nach_sklad_01', id, 'assign_procurement', { assigneeId: users['snab_01'].id });
    await act('snab_01', id, 'add_quotation', { amount: 100000, supplierName: 'ООО Тест-Снаб' });
    await act('nach_snab_01', id, 'approve_price');
    await act('zamdir_01', id, 'approve');
    await act('gendir_01', id, 'approve');
    await act('founder_01', id, 'approve');
    await act('snab_01', id, 'mark_arrived');
    await act('sklad_01', id, 'receive_full');
    await act('sklad_01', id, 'close');

    const [done] = await db.select().from(schema.requests).where(eq(schema.requests.id, id));
    expect(done.status).toBe('closed');
  });

  it('hides other-step actions from a user (кому какие кнопки доступны)', async () => {
    const db = await makeDb();
    const { users, requests } = await seedTest(db);
    const [req] = await db.select().from(schema.requests).where(eq(schema.requests.id, requests.fresh.id));
    // Step 1 belongs to the warehouse head: he can act, the procurement user cannot.
    // №16б: перед закупкой вместо approve — assign_procurement.
    const forNach = await availableActions(db, req, users['nach_sklad_01'].id);
    expect(forNach.map((a: any) => a.action)).toContain('assign_procurement');
    expect(forNach.map((a: any) => a.action)).not.toContain('approve');
    const forSnab = await availableActions(db, req, users['snab_01'].id);
    expect(forSnab.map((a: any) => a.action)).not.toContain('approve');
    expect(forSnab.map((a: any) => a.action)).not.toContain('assign_procurement');
  });
});
