/**
 * One-off: wipe ALL requests and their transactional children for a clean test.
 * Preserves org/roles/users/workflows/materials and stock balances.
 * Run: npx tsx scripts/clear-requests.ts
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { assertWipeAllowed } from './_wipe-guard.js';

async function main() {
  assertWipeAllowed('clear-requests.ts');
  const url = process.env.DATABASE_URL;
  const needsSsl = Boolean(url && /neon\.tech|sslmode=require|amazonaws\.com/.test(url));
  const pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  const before = (await pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n;

  // P1-8: request→history FKs are now RESTRICT (no cascade), so this dev-only
  // cleanup must delete children explicitly, in dependency order. This is the
  // deliberate, guarded escape hatch — the app never hard-deletes requests.
  await pool.query('DELETE FROM signatures');
  await pool.query('DELETE FROM approvals');
  await pool.query('DELETE FROM reservations');
  await pool.query('DELETE FROM quotations');
  await pool.query('DELETE FROM request_status_history');
  await pool.query('DELETE FROM request_items');
  await pool.query('DELETE FROM attachments');
  await pool.query('UPDATE stock_movements SET request_id = NULL WHERE request_id IS NOT NULL');
  await pool.query('DELETE FROM requests');

  const after = (await pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n;
  console.log(`requests: ${before} → ${after}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
