/** CLI: `npm run seed:demo-workflows` — procurement/finance demo data. Dev/staging/local ONLY. */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedDemoWorkflows } from './seed-demo-workflows.js';
import { PILOT_PIN } from './seed-pilot.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
// Safety: demo data must NEVER land in production. Refuse unless explicitly forced.
if (process.env.NODE_ENV === 'production' && process.env.FORCE_DEMO_SEED !== '1') {
  console.error('Refusing to seed demo data with NODE_ENV=production (dev/staging only).');
  console.error('If you really mean to seed THIS database, re-run with FORCE_DEMO_SEED=1.');
  process.exit(1);
}
const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
const db = drizzle(pool);

await seedDemoWorkflows(db);
await pool.end();

console.log('✅ Demo workflows seeded — Holding "Zelal Group" (on top of seed:pilot)');
console.log('   Extra demo users (Telegram id → role):');
console.log(`     demo_procurement → procurement (PIN ${PILOT_PIN})`);
console.log(`     demo_finance     → finance     (PIN ${PILOT_PIN})`);
console.log('   Workflow: Demo Full Workflow (approval → warehouse_check → procurement → finance_payment → receiving → issue → close)');
console.log('   Demo requests: «Demo: заявка в закупке» (procurement), «Demo: заявка на оплате» (finance_payment, no invoice yet)');
