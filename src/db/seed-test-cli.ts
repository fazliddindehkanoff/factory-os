/** CLI: `npm run seed:test` — seed the multi-window role-testing data. Dev/test only. */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedTest, TEST_USERS, TEST_PIN } from './seed-test.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
// Safety: test data must NEVER land in production. Refuse unless explicitly forced.
if (process.env.NODE_ENV === 'production' && process.env.FORCE_DEMO_SEED !== '1') {
  console.error('Refusing to seed test data with NODE_ENV=production (dev/staging only).');
  console.error('If you really mean to seed THIS database, re-run with FORCE_DEMO_SEED=1.');
  process.exit(1);
}
const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
const db = drizzle(pool);

await seedTest(db);
await pool.end();

console.log('✅ Test QA data seeded — Holding «Тестовый завод»');
console.log(`   Вход в мини-аппе: /?user=<логин>  (PIN у всех: ${TEST_PIN})`);
for (const u of TEST_USERS) {
  console.log(`     ${u.username.padEnd(14)} → ${u.name} [${u.roles.join(', ')}]`);
}
