/**
 * CLI: `npm run seed:test-logins -- "<Holding name>"` — прикрепляет dev-login
 * тестовых пользователей (TEST_USERS из seed-test.ts) к УЖЕ существующему
 * холдингу — например, к клону боевой базы на тестовом стенде. Дополнительно
 * заводит по пользователю на каждую кастомную (holding-scoped) роль холдинга:
 * логин `<код роли>_01`. Конфигурацию холдинга не меняет — только добавляет
 * пользователей и назначения ролей. Идемпотентно.
 *
 * Dev/staging only — как и seed:test, отказывается при NODE_ENV=production
 * без FORCE_DEMO_SEED=1.
 */
import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from './schema.js';
import { hashPin } from '../auth/pin.js';
import { TEST_USERS, TEST_PIN } from './seed-test.js';

const holdingName = process.argv[2];
if (!holdingName) {
  console.error('Usage: tsx src/db/seed-test-logins-cli.ts "<Holding name>"');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.FORCE_DEMO_SEED !== '1') {
  console.error('Refusing to seed test logins with NODE_ENV=production (dev/staging only).');
  console.error('If you really mean to seed THIS database, re-run with FORCE_DEMO_SEED=1.');
  process.exit(1);
}

const needsSsl = /neon\.tech|sslmode=require|amazonaws\.com/.test(url);
const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
const db = drizzle(pool);

const [holding] = await db.select().from(schema.holdings).where(eq(schema.holdings.name, holdingName));
if (!holding) {
  console.error(`Holding not found: «${holdingName}»`);
  const all = await db.select({ name: schema.holdings.name }).from(schema.holdings);
  console.error('Available:', all.map((h) => h.name).join(', ') || '(none)');
  await pool.end();
  process.exit(1);
}

async function ensureUser(username: string, fullName: string, phone?: string) {
  let [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, username));
  if (!u) {
    [u] = await db
      .insert(schema.users)
      .values({
        holdingId: holding.id,
        telegramId: username,
        phone: phone ?? null,
        fullName,
        position: fullName,
        status: 'active',
        pinHash: hashPin(TEST_PIN),
      })
      .returning();
  } else if (u.holdingId !== holding.id || (phone && u.phone !== phone)) {
    // Пользователь остался от старого сида в другом холдинге или ещё не получил
    // детерминированный тестовый телефон — синхронизируем профиль.
    [u] = await db
      .update(schema.users)
      .set({ holdingId: holding.id, ...(phone ? { phone } : {}), fullName, position: fullName, status: 'active', pinHash: hashPin(TEST_PIN) })
      .where(eq(schema.users.id, u.id))
      .returning();
  }
  return u;
}

async function ensureRole(userId: string, roleId: string) {
  const existing = await db
    .select()
    .from(schema.userRoles)
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.roleId, roleId)));
  if (existing.length === 0) {
    await db.insert(schema.userRoles).values({ userId, roleId, holdingId: holding.id });
  }
}

console.log(`Холдинг: «${holding.name}» (${holding.id})`);
console.log(`PIN у всех тестовых логинов: ${TEST_PIN}`);

for (const spec of TEST_USERS) {
  const u = await ensureUser(spec.username, spec.name, spec.phone);
  for (const code of spec.roles) {
    const [r] = await db
      .select()
      .from(schema.roles)
      .where(and(isNull(schema.roles.holdingId), eq(schema.roles.code, code)));
    if (!r) throw new Error(`system role not found: ${code}`);
    await ensureRole(u.id, r.id);
  }
  console.log(`  ${spec.username.padEnd(16)} +${spec.phone} → ${spec.name} [${spec.roles.join(', ')}]`);
}

// Кастомные роли холдинга (созданные админом в конструкторе) — по логину на каждую,
// иначе шаги маршрута с такими ролями некому пройти в тест-режиме.
const customRoles = await db.select().from(schema.roles).where(eq(schema.roles.holdingId, holding.id));
for (const r of customRoles) {
  const username = `${r.code}_01`;
  const u = await ensureUser(username, `${r.name} (тест)`);
  await ensureRole(u.id, r.id);
  console.log(`  ${username.padEnd(16)} → ${r.name} [кастомная роль ${r.code}]`);
}

await pool.end();
console.log('✅ Тестовые dev-логины прикреплены. Вход: /?phone=<телефон>');
