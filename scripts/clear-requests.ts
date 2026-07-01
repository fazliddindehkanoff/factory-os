/**
 * One-off: wipe ALL requests and their transactional children for a clean test.
 * Preserves org/roles/users/workflows/materials and stock balances.
 * Run: npx tsx scripts/clear-requests.ts
 */
import 'dotenv/config';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const before = (await pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n;

  // Non-cascade FKs to requests must be cleared first.
  await pool.query('DELETE FROM signatures');
  await pool.query('UPDATE stock_movements SET request_id = NULL WHERE request_id IS NOT NULL');
  // Cascade removes request_items / status_history / approvals / quotations / reservations.
  await pool.query('DELETE FROM requests');

  const after = (await pool.query('SELECT count(*)::int AS n FROM requests')).rows[0].n;
  console.log(`requests: ${before} → ${after}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
