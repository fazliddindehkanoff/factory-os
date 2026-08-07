/** Production entrypoint: load env, connect to Postgres, serve the API. */
import 'dotenv/config';
import { loadEnv, devAuthEnabled } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createApp } from './app.js';
import { createBot, makeNotifier, type Notifier } from '../bot/bot.js';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';
import { normalizePhone } from '../auth/phone.js';
import { runEscalations } from '../services/escalation.service.js';
import { runDigests } from '../services/digest.service.js';

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
// Dev login is OFF unless explicitly enabled in a development environment (fail-closed).
const devAuth = devAuthEnabled(env);
// serveDesign=true → old compat layer (public/); false → canonical React Mini App (web/dist).
// Default to the canonical path; the legacy compat layer is opt-in via SERVE_DESIGN=1. (H2)
const serveDesign = process.env.SERVE_DESIGN === '1';

// Bot is optional: only runs if a token is configured.
let notify: Notifier | undefined;
let bot: ReturnType<typeof createBot> | undefined;
if (env.BOT_TOKEN) {
  const appUrl = env.APP_URL ?? `http://localhost:${env.PORT}`;
  bot = createBot(
    env.BOT_TOKEN,
    appUrl,
    async (tgId) => {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, tgId));
      return u?.holdingId ? getUserPermissionCodes(db, u.id) : [];
    },
    async (tgId) => {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, tgId));
      return !!u?.holdingId;
    },
    async (rawPhone, tgId) => {
      const phone = normalizePhone(rawPhone);
      const [u] = await db.select().from(schema.users).where(eq(schema.users.phone, phone));
      if (!u) return { linked: false };
      await db.update(schema.users).set({ telegramId: tgId, status: 'active', updatedAt: new Date() }).where(eq(schema.users.id, u.id));
      return { linked: true, fullName: u.fullName };
    },
  );
  notify = makeNotifier(bot);
  bot.start({ onStart: (info) => console.log(`🤖 Bot @${info.username} started`) }).catch((e) =>
    console.error('Bot error:', (e as Error).message),
  );
} else {
  console.log('⚠️  BOT_TOKEN not set — API-only mode (no bot, no notifications)');
}

const app = createApp({
  db,
  botToken: env.BOT_TOKEN,
  sessionSecret: env.SESSION_SECRET,
  devAuth,
  notify,
  serveDesign,
});

const server = app.listen(env.PORT, () => {
  console.log(`✅ Factory OS API on http://localhost:${env.PORT}`);
});

// ── Фоновые задачи ────────────────────────────────────────────────────────────
// Эскалации по таймауту шага — каждые 10 минут; дайджесты — каждые 5 минут
// (сервис сам решает, какому холдингу/пользователю пора по его интервалу).
// Работают и без бота: уведомления лягут in-app, без TG-пуша.
const guardedJob = (name: string, fn: () => Promise<unknown>) => {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[jobs] ${name} failed:`, (e as Error).message);
    } finally {
      running = false;
    }
  };
};
const escalationJob = guardedJob('escalations', () => runEscalations(db, notify));
const digestJob = guardedJob('digests', () => runDigests(db, notify));
setInterval(escalationJob, 10 * 60_000).unref();
setInterval(digestJob, 5 * 60_000).unref();
// Первый прогон вскоре после старта, чтобы просрочки не ждали первого тика.
setTimeout(() => { void escalationJob(); void digestJob(); }, 30_000).unref();

const shutdown = (signal: string) => {
  console.log(`[server] ${signal} received, shutting down gracefully...`);
  if (bot) bot.stop();
  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[server] Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
