/**
 * seed:demo-workflows — parks demo requests on the procurement and finance steps
 * (data-level; idempotent). Verifies the seed without needing a real Postgres.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import * as schema from './schema.js';
import { seedDemoWorkflows } from './seed-demo-workflows.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

describe('seed:demo-workflows', () => {
  it('parks demo requests at procurement and finance_payment with demo users', async () => {
    const db = await setup();
    const r = await seedDemoWorkflows(db);

    const [proc] = await db.select().from(schema.requests).where(eq(schema.requests.id, r.procRequestId));
    const [fin] = await db.select().from(schema.requests).where(eq(schema.requests.id, r.finRequestId));
    expect(proc.status).toBe('procurement');
    expect(fin.status).toBe('finance_payment');
    expect(fin.currentStepId).toBeTruthy();
    expect(Number(fin.estimatedAmount)).toBe(5_000_000);

    // demo procurement + finance users exist, PIN-gated
    const [finUser] = await db.select().from(schema.users).where(eq(schema.users.telegramId, 'demo_finance'));
    expect(finUser.pinHash).toBeTruthy();
    const [procUser] = await db.select().from(schema.users).where(eq(schema.users.telegramId, 'demo_procurement'));
    expect(procUser.pinHash).toBeTruthy();

    // the demo workflow is inactive (must not override the active Pilot Workflow)
    expect(r.workflow.isActive).toBe(false);
  });

  it('is idempotent — re-running does not duplicate requests', async () => {
    const db = await setup();
    const a = await seedDemoWorkflows(db);
    const b = await seedDemoWorkflows(db);
    expect(b.finRequestId).toBe(a.finRequestId);
    expect(b.procRequestId).toBe(a.procRequestId);
    const fins = await db
      .select()
      .from(schema.requests)
      .where(and(eq(schema.requests.holdingId, a.holding.id), eq(schema.requests.title, 'Demo: заявка на оплате')));
    expect(fins.length).toBe(1);
  });
});
