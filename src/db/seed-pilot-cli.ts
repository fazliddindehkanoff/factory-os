/** CLI: `npm run seed:pilot` — seed the deterministic pilot/demo data. Dev/demo only. */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedPilot, PILOT_PIN } from './seed-pilot.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
const db = drizzle(pool);

await seedPilot(db);
await pool.end();

console.log('✅ Pilot demo seeded — Holding "Zelal Group"');
console.log('   Demo users (Telegram id → role):');
console.log(`     pilot_requester → requester`);
console.log(`     pilot_director  → director   (PIN ${PILOT_PIN})`);
console.log(`     pilot_warehouse → warehouse  (PIN ${PILOT_PIN})`);
console.log(`     pilot_admin     → admin`);
console.log('   Materials: «Подшипник 6205» = 100, «Ремень приводной A-100» = 1');
console.log('   Workflow: Pilot Workflow (approval → warehouse_check → issue → close)');
