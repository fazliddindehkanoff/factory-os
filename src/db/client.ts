/** Creates a Drizzle client over a node-postgres pool (production / real Postgres). */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createDb(connectionString: string) {
  const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
