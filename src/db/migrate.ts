/**
 * Applies generated SQL migrations to the real Postgres pointed to by DATABASE_URL.
 * Used for Neon / a real instance. Tests use an in-process pglite instead.
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// Neon (and most managed Postgres) require TLS. node-postgres doesn't always honor
// sslmode= from the URL, so enable it explicitly for known-remote hosts.
const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({
  connectionString: url,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
});
const db = drizzle(pool);
await migrate(db, { migrationsFolder: './drizzle' });
await pool.end();
console.log('✅ migrations applied');
