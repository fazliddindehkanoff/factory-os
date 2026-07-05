/**
 * Retry delivery of notifications stuck in status='failed'.
 * Safe to run on any environment (read + best-effort re-send only; no deletes).
 * Run: npx tsx scripts/retry-notifications.ts
 */
import 'dotenv/config';
import { createDb } from '../src/db/client.js';
import { createBot, makeNotifier } from '../src/bot/bot.js';
import { retryFailedNotifications } from '../src/services/notification.service.js';

async function main() {
  const { db } = createDb(process.env.DATABASE_URL!);
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('BOT_TOKEN not set — cannot deliver. Nothing to do.');
    process.exit(1);
  }
  const bot = createBot(token, process.env.APP_URL ?? '');
  const deliver = makeNotifier(bot);
  const { attempted, delivered } = await retryFailedNotifications(db, deliver, { limit: 200 });
  console.log(`Retried ${attempted} failed notification(s); ${delivered} delivered.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
