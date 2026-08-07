/**
 * grammY bot: /start opens the Mini App and installs a per-user command menu that
 * matches the user's role (resolved from their Telegram id). The Telegram "Menu"
 * button opens the Mini App for everyone. Outbound notifications are fire-and-forget.
 * Only constructed when BOT_TOKEN is set (see server bootstrap).
 */
import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { startMessage, helpMessage, askPhoneMessage, phoneLinkedMessage, phoneNotFoundMessage } from './messages.js';

/** Resolve a user's effective permission codes from their Telegram id (empty if unknown). */
export type PermResolver = (telegramId: string) => Promise<string[]>;

/** True if this Telegram id is already linked to a provisioned (holding-assigned) user. */
export type HasAccount = (telegramId: string) => Promise<boolean>;

/**
 * Looks up a user by normalized phone and links their Telegram id onto that row.
 * Never creates a new user — only an admin-provisioned phone can be linked.
 */
export type LinkByPhone = (phone: string, telegramId: string) => Promise<{ linked: boolean; fullName?: string }>;

// Role-aware command entries, each gated by a permission. `perm: null` → always shown.
// The set a given user sees is their personal Telegram "/" menu.
const MENU: { command: string; description: string; perm: string | null }[] = [
  { command: 'app', description: 'Открыть Factory OS', perm: null },
  { command: 'tasks', description: 'Мои согласования и задачи', perm: 'approvals.approve' },
  { command: 'warehouse', description: 'Склад', perm: 'warehouse.view' },
  { command: 'procurement', description: 'Закупки', perm: 'procurement.view' },
  { command: 'finance', description: 'Финансы', perm: 'finance.view' },
  { command: 'newrequest', description: 'Создать заявку', perm: 'requests.create' },
  { command: 'admin', description: 'Администрирование', perm: 'settings.manage' },
  { command: 'help', description: 'Помощь', perm: null },
];

export function createBot(
  token: string,
  appUrl: string,
  resolvePerms?: PermResolver,
  hasAccount?: HasAccount,
  linkByPhone?: LinkByPhone,
) {
  const bot = new Bot(token);
  const openKb = (label = '🏭 Открыть Factory OS') => new InlineKeyboard().webApp(label, appUrl);
  const phoneKb = () => new Keyboard().requestContact('📱 Поделиться номером').resized().oneTime();

  // The chat "Menu" button opens the Mini App for everyone.
  bot.api
    .setChatMenuButton({ menu_button: { type: 'web_app', text: 'Factory OS', web_app: { url: appUrl } } })
    .catch((e: unknown) => console.error('[bot] setChatMenuButton', (e as Error)?.message));
  // Global default commands (shown until /start learns the user's role).
  bot.api
    .setMyCommands([
      { command: 'start', description: 'Запуск' },
      { command: 'app', description: 'Открыть Factory OS' },
      { command: 'help', description: 'Помощь' },
    ])
    .catch((e: unknown) => console.error('[bot] setMyCommands', (e as Error)?.message));

  const permsOf = async (ctx: Context): Promise<string[]> =>
    resolvePerms && ctx.from ? resolvePerms(String(ctx.from.id)).catch(() => []) : [];

  bot.command('start', async (ctx) => {
    // Unknown Telegram id → must prove identity via phone before anything else.
    // hasAccount is optional so this stays a no-op (today's behavior) if the caller
    // doesn't wire it up (e.g. in a lightweight test bot).
    const linked = hasAccount && ctx.from ? await hasAccount(String(ctx.from.id)).catch(() => false) : true;
    if (!linked) {
      await ctx.reply(askPhoneMessage(), { reply_markup: phoneKb() });
      return;
    }
    const perms = await permsOf(ctx);
    // Install this user's personal command menu (scoped to their chat).
    if (ctx.chat) {
      const cmds = MENU.filter((m) => m.perm === null || perms.includes(m.perm)).map(({ command, description }) => ({ command, description }));
      await bot.api
        .setMyCommands([{ command: 'start', description: 'Запуск' }, ...cmds], { scope: { type: 'chat', chat_id: ctx.chat.id } })
        .catch((e: unknown) => console.error('[bot] per-chat setMyCommands', (e as Error)?.message));
    }
    await ctx.reply(startMessage(ctx.from?.first_name), { reply_markup: openKb() });
  });

  // Contact-share reply to the phone-request keyboard shown above.
  bot.on('message:contact', async (ctx) => {
    const contact = ctx.message.contact;
    if (!linkByPhone || !ctx.from) return;
    // The shared contact must belong to the same Telegram account issuing /start —
    // otherwise anyone could share someone else's saved contact to hijack their account.
    if (contact.user_id !== ctx.from.id) {
      await ctx.reply(phoneNotFoundMessage(), { reply_markup: { remove_keyboard: true } });
      return;
    }
    const result = await linkByPhone(contact.phone_number, String(ctx.from.id)).catch(
      (): { linked: boolean; fullName?: string } => ({ linked: false }),
    );
    if (!result.linked) {
      await ctx.reply(phoneNotFoundMessage(), { reply_markup: { remove_keyboard: true } });
      return;
    }
    await ctx.reply(phoneLinkedMessage(result.fullName), { reply_markup: { remove_keyboard: true } });
    await ctx.reply(startMessage(ctx.from.first_name), { reply_markup: openKb() });
  });

  bot.command('app', async (ctx) => {
    await ctx.reply('Открываю Factory OS:', { reply_markup: openKb() });
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(helpMessage());
  });
  // Role commands open the app (deep-linking to a specific section is a follow-up).
  for (const m of MENU) {
    if (m.command === 'app' || m.command === 'help') continue;
    bot.command(m.command, async (ctx) => {
      await ctx.reply(`${m.description}:`, { reply_markup: openKb('🏭 Открыть') });
    });
  }

  return bot;
}

/**
 * Promise-returning delivery channel: resolves on success, REJECTS on failure so
 * the notification layer can record status='failed' (P1-6). This replaces the old
 * fire-and-forget notifier that swallowed errors.
 */
export type Notifier = (telegramId: string, text: string) => Promise<void>;

/** Wraps a bot into a delivery function whose promise reflects send success/failure. */
export function makeNotifier(bot: Bot): Notifier {
  return (telegramId, text) => bot.api.sendMessage(telegramId, text).then(() => undefined);
}
