/**
 * CLI: `npm run seed:namenklatura -- "<Holding name>"` — one-time bulk import of
 * the namenklatura.xlsx export (src/db/seed-data/namenklatura.json: 3,313 unique
 * product codes with category/unit in Russian and the original title in Turkish)
 * plus the 7 distinct unit types it uses. Idempotent: upserts materials by
 * (holdingId, sku) and unit types by (holdingId, code), safe to re-run.
 *
 * The Turkish title is the only language we have per product — it seeds BOTH the
 * required `name` column (so nothing renders blank across the app) and `nameTr`
 * (the authoritative "original" column). `nameUz` is left blank for an admin to
 * fill in via the new Namenklatura page. Unit type translations are a small,
 * hand-checked list (only 7 words), not machine-translated.
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const holdingName = process.argv[2];
if (!holdingName) {
  console.error('Usage: tsx src/db/seed-namenklatura-cli.ts "<Holding name>"');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

type Row = { code: string; titleTr: string; category: string; unit: string };
const rows: Row[] = JSON.parse(readFileSync(join(__dirname, 'seed-data/namenklatura.json'), 'utf8'));

const UNIT_TYPES: { code: string; nameRu: string; nameUz: string; nameTr: string }[] = [
  { code: 'pcs', nameRu: 'шт', nameUz: 'dona', nameTr: 'adet' },
  { code: 'kg', nameRu: 'кг', nameUz: 'kg', nameTr: 'kg' },
  { code: 'g', nameRu: 'г', nameUz: 'gramm', nameTr: 'gram' },
  { code: 'l', nameRu: 'л', nameUz: 'litr', nameTr: 'litre' },
  { code: 'm', nameRu: 'м', nameUz: 'metr', nameTr: 'metre' },
  { code: 'pack', nameRu: 'уп', nameUz: "o'ram", nameTr: 'paket' },
  { code: 'set', nameRu: 'компл.', nameUz: "to'plam", nameTr: 'takım' },
];

const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
const db = drizzle(pool);

const [holding] = await db.select().from(schema.holdings).where(eq(schema.holdings.name, holdingName));
if (!holding) {
  console.error(`Holding not found: «${holdingName}»`);
  const all = await db.select({ name: schema.holdings.name }).from(schema.holdings);
  console.error('Available:', all.map((h: { name: string }) => h.name).join(', ') || '(none)');
  await pool.end();
  process.exit(1);
}

// ── Unit types ──────────────────────────────────────────────────────────────
const existingUnits = await db.select().from(schema.unitTypes).where(eq(schema.unitTypes.holdingId, holding.id));
const unitByCode = new Map(existingUnits.map((u: { code: string }) => [u.code, u]));
for (let i = 0; i < UNIT_TYPES.length; i++) {
  const ut = UNIT_TYPES[i];
  const existing = unitByCode.get(ut.code) as { id: string } | undefined;
  if (existing) {
    await db
      .update(schema.unitTypes)
      .set({ nameRu: ut.nameRu, nameUz: ut.nameUz, nameTr: ut.nameTr, orderIndex: i })
      .where(eq(schema.unitTypes.id, existing.id));
  } else {
    await db.insert(schema.unitTypes).values({ holdingId: holding.id, ...ut, orderIndex: i });
  }
}
console.log(`✅ ${UNIT_TYPES.length} unit types upserted`);

// ── Materials (namenklatura) ───────────────────────────────────────────────
const existingMaterials = await db
  .select({ id: schema.materials.id, sku: schema.materials.sku })
  .from(schema.materials)
  .where(eq(schema.materials.holdingId, holding.id));
const materialIdBySku = new Map(existingMaterials.map((m: { id: string; sku: string | null }) => [m.sku, m.id]));

const toInsert: (typeof schema.materials.$inferInsert)[] = [];
let updated = 0;
for (const row of rows) {
  const values = {
    holdingId: holding.id,
    sku: row.code,
    name: row.titleTr || row.code,
    nameTr: row.titleTr || null,
    category: row.category || null,
    defaultUnit: row.unit || null,
  };
  const existingId = materialIdBySku.get(row.code);
  if (existingId) {
    await db.update(schema.materials).set(values).where(eq(schema.materials.id, existingId as string));
    updated++;
  } else {
    toInsert.push(values);
  }
}

const CHUNK = 500;
for (let i = 0; i < toInsert.length; i += CHUNK) {
  await db.insert(schema.materials).values(toInsert.slice(i, i + CHUNK));
}
console.log(`✅ materials: ${toInsert.length} inserted, ${updated} updated (${rows.length} total rows)`);

await pool.end();
