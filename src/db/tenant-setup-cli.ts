/**
 * Bootstraps a tenant in the real Postgres (DATABASE_URL).
 *   HOLDING_NAME=...  OWNER_TELEGRAM_ID=...  OWNER_NAME=...  npm run tenant:setup
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { setupTenant } from './tenant-setup.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});
const db = drizzle(pool);

// M3: demo users (demo_owner etc.) only outside production — or with an explicit force flag.
const seedDemoUsers = process.env.NODE_ENV !== 'production' || process.env.FORCE_DEMO_SEED === '1';
if (seedDemoUsers) console.warn('⚠️  Seeding demo users (demo_owner etc.) — dev/staging only, never production.');
const result = await setupTenant(db, {
  holdingName: process.env.HOLDING_NAME ?? 'Zelal Tekstil',
  ownerTelegramId: process.env.OWNER_TELEGRAM_ID,
  ownerName: process.env.OWNER_NAME,
  seedDemoUsers,
});

console.log(
  '✅ tenant ready:',
  JSON.stringify({
    holding: result.holding.name,
    factory: result.factory.name,
    workflow: result.workflow.name,
    owner: result.owner?.telegramId ?? '(not assigned)',
  }),
);
await pool.end();
