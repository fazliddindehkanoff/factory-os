/** Seeds global roles/permissions into the real Postgres pointed to by DATABASE_URL. */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { seedSystemRolesAndPermissions } from './seed.js';

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
await seedSystemRolesAndPermissions(db);
await pool.end();
console.log('✅ system roles & permissions seeded');
