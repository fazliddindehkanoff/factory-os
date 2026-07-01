/**
 * One-off: backfill workflow_steps.step_kind for workflows created before the
 * data-driven engine existed (their steps defaulted to 'approval'). We infer the
 * kind from the step name so existing configured chains behave operationally
 * (warehouse check / procurement / payment / …) instead of as plain sign-offs.
 *
 * Safe & idempotent: only sets step_kind; never touches order / role / conditions.
 * Run: npx tsx scripts/fix-step-kinds.ts
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';

function inferKind(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('склад') && (n.includes('провер') || n.includes('налич'))) return 'warehouse_check';
  if (n.includes('поставщик') || n.includes('закупк') || n.includes('кп')) return 'procurement';
  if (n.includes('оплат')) return 'finance_payment';
  if (n.includes('доставк')) return 'delivery';
  if ((n.includes('приём') || n.includes('приемк')) && n.includes('склад')) return 'receiving';
  if (n.includes('выдач')) return 'issue';
  if (n.includes('закрыт') || (n.includes('подтвержд') && n.includes('получен'))) return 'close';
  return 'approval';
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const db = drizzle(pool, { schema });
  const steps = await db.select().from(schema.workflowSteps);
  let changed = 0;
  for (const s of steps) {
    const want = inferKind(s.stepName);
    if (s.stepKind !== want) {
      await db.update(schema.workflowSteps).set({ stepKind: want }).where(eq(schema.workflowSteps.id, s.id));
      changed++;
      console.log(`  ${s.stepName} : ${s.stepKind} → ${want}`);
    }
  }
  console.log(`\n✅ Updated ${changed} of ${steps.length} steps.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
