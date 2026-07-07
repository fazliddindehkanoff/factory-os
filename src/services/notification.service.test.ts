/**
 * P1-6: notifications are persisted before delivery; failures are recorded, not
 * lost; a user can only list their own.
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import {
  notifyUser,
  listUserNotifications,
  unreadCount,
  markRead,
  retryFailedNotifications,
} from './notification.service.js';

async function setup() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const [holding] = await db.insert(schema.holdings).values({ name: 'H' }).returning();
  const [alice] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: 'Alice', telegramId: 'tg-alice', status: 'active' })
    .returning();
  const [bob] = await db
    .insert(schema.users)
    .values({ holdingId: holding.id, fullName: 'Bob', telegramId: 'tg-bob', status: 'active' })
    .returning();
  return { db, holding, alice, bob };
}

describe('P1-6: notification persistence', () => {
  it('creates a row and marks it delivered on success', async () => {
    const { db, holding, alice } = await setup();
    const sent: Array<[string, string]> = [];
    const deliver = async (tg: string, text: string) => { sent.push([tg, text]); };

    const row = await notifyUser(db, deliver, {
      holdingId: holding.id,
      recipientUserId: alice.id,
      title: 'T',
      message: 'hello',
      entityType: 'request',
      entityId: null,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('tg-alice');
    const [stored] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id));
    expect(stored.status).toBe('delivered');
    expect(stored.deliveredAt).not.toBeNull();
  });

  it('без Telegram-канала уведомление считается доставленным in-app (не failed)', async () => {
    const { db, holding, alice } = await setup();
    // deliver=undefined — стенд/дев без BOT_TOKEN или админ-роутер без бота.
    const row = await notifyUser(db, undefined, {
      holdingId: holding.id,
      recipientUserId: alice.id,
      title: 'T',
      message: 'in-app only',
      kind: 'step_pending',
    });
    const [stored] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id));
    expect(stored.status).toBe('delivered');
    expect(stored.channel).toBe('inapp');
    expect(stored.errorMessage).toBeNull();
    expect(stored.kind).toBe('step_pending');
    expect(await unreadCount(db, alice.id)).toBe(1);
  });

  it('получатель без telegram_id — тоже in-app delivered, а не failed', async () => {
    const { db, holding } = await setup();
    const [noTg] = await db
      .insert(schema.users)
      .values({ holdingId: holding.id, fullName: 'NoTg', telegramId: null, status: 'active' })
      .returning();
    const deliver = async () => { throw new Error('must not be called'); };
    const row = await notifyUser(db, deliver, { holdingId: holding.id, recipientUserId: noTg.id, title: 'T', message: 'x' });
    const [stored] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id));
    expect(stored.status).toBe('delivered');
    expect(stored.channel).toBe('inapp');
  });

  it('records status=failed when delivery throws (nothing lost)', async () => {
    const { db, holding, alice } = await setup();
    const deliver = async () => { throw new Error('bot blocked'); };

    const row = await notifyUser(db, deliver, {
      holdingId: holding.id,
      recipientUserId: alice.id,
      title: 'T',
      message: 'x',
    });

    const [stored] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id));
    expect(stored.status).toBe('failed');
    expect(stored.errorMessage).toMatch(/bot blocked/);
  });

  it('retries failed notifications and marks them delivered', async () => {
    const { db, holding, alice } = await setup();
    let fail = true;
    const deliver = async () => { if (fail) throw new Error('temporary'); };

    await notifyUser(db, deliver, { holdingId: holding.id, recipientUserId: alice.id, title: 'T', message: 'y' });
    fail = false;
    const { attempted, delivered } = await retryFailedNotifications(db, deliver);
    expect(attempted).toBe(1);
    expect(delivered).toBe(1);
    expect(await unreadCount(db, alice.id)).toBe(1);
  });

  it('lists only the recipient own notifications; unread/read transitions', async () => {
    const { db, holding, alice, bob } = await setup();
    const deliver = async () => {};
    const aRow = await notifyUser(db, deliver, { holdingId: holding.id, recipientUserId: alice.id, title: 'A', message: '1' });
    await notifyUser(db, deliver, { holdingId: holding.id, recipientUserId: bob.id, title: 'B', message: '2' });

    const aliceList = await listUserNotifications(db, alice.id);
    expect(aliceList).toHaveLength(1);
    expect(aliceList[0].recipientUserId).toBe(alice.id);
    expect(await unreadCount(db, alice.id)).toBe(1);

    // Bob cannot mark Alice's notification as read.
    expect(await markRead(db, bob.id, aRow.id)).toBe(false);
    expect(await markRead(db, alice.id, aRow.id)).toBe(true);
    expect(await unreadCount(db, alice.id)).toBe(0);
  });
});
