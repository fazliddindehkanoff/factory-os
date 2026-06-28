/** Production entrypoint: load env, connect to Postgres, serve the API. */
import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createApp } from './app.js';
import { createBot, makeNotifier, type Notifier } from '../bot/bot.js';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { getUserPermissionCodes } from '../rbac/rbac.js';

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
// Dev login is OFF unless explicitly enabled in a development environment.
const devAuth = env.NODE_ENV === 'development' && env.ENABLE_DEV_AUTH === '1';
// serveDesign=true → old compat layer (public/); false → new React Mini App (web/dist)
const serveDesign = process.env.SERVE_DESIGN !== '0';

// Bot is optional: only runs if a token is configured.
let notify: Notifier | undefined;
if (env.BOT_TOKEN) {
  const appUrl = env.APP_URL ?? `http://localhost:${env.PORT}`;
  const bot = createBot(env.BOT_TOKEN, appUrl, async (tgId) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, tgId));
    return u?.holdingId ? getUserPermissionCodes(db, u.id) : [];
  });
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

app.listen(env.PORT, () => {
  console.log(`✅ Factory OS API on http://localhost:${env.PORT}`);
});
