/**
 * Auth for the bundled design's API contract. The design sends, per request:
 *   - X-Telegram-Init-Data (real Telegram), or
 *   - X-Dev-User-Id: demo_<role> (dev / role switcher), or
 *   - Authorization: Bearer <session> (also accepted).
 * Resolves the DB user onto req.dbUser. Fails closed.
 */
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { verifySession } from '../auth/session.js';
import { verifyInitData } from '../auth/telegram.js';

type Db = any;

export interface LegacyAuthDeps {
  db: Db;
  sessionSecret: string;
  botToken: string;
  devAuth: boolean;
}

async function userByTelegramId(db: Db, telegramId: string) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.telegramId, telegramId));
  return u ?? null;
}

/** A deactivated/archived user must not authenticate (the admin "deactivate" must mean something). */
const isActiveUser = (u: { status?: string } | null | undefined): boolean =>
  !!u && u.status !== 'disabled' && u.status !== 'archived';

export function legacyAuth(deps: LegacyAuthDeps) {
  const { db, sessionSecret, botToken, devAuth } = deps;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authz = req.header('authorization') ?? '';
      if (authz.startsWith('Bearer ')) {
        const p = verifySession(authz.slice(7), sessionSecret);
        if (p) {
          const [u] = await db.select().from(schema.users).where(eq(schema.users.id, p.uid));
          if (isActiveUser(u)) {
            (req as Request & { dbUser?: unknown }).dbUser = u;
            return next();
          }
        }
      }

      const initData = req.header('x-telegram-init-data');
      if (initData) {
        const tg = verifyInitData(initData, botToken);
        if (!tg) {
          res.status(401).json({ error: 'Invalid initData' });
          return;
        }
        let u = await userByTelegramId(db, tg.id);
        if (!u) {
          [u] = await db
            .insert(schema.users)
            .values({
              telegramId: tg.id,
              fullName: [tg.firstName, tg.lastName].filter(Boolean).join(' ') || tg.username || 'User',
              status: 'active',
            })
            .returning();
        }
        if (!isActiveUser(u)) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        (req as Request & { dbUser?: unknown }).dbUser = u;
        return next();
      }

      const devId = req.header('x-dev-user-id');
      if (devId && devAuth) {
        const u = await userByTelegramId(db, devId);
        if (!isActiveUser(u)) {
          res.status(401).json({ error: 'Unknown or inactive dev user' });
          return;
        }
        (req as Request & { dbUser?: unknown }).dbUser = u;
        return next();
      }

      res.status(401).json({ error: 'Unauthorized' });
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

const ROLE_PRIORITY = ['owner', 'director', 'admin', 'finance', 'procurement', 'warehouse', 'dept_head', 'requester'];

/** The design expects a single role string; pick the highest-privilege role the user holds. */
export async function primaryRole(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({ code: schema.roles.code })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(eq(schema.userRoles.userId, userId));
  const codes = rows.map((r: { code: string }) => r.code);
  for (const c of ROLE_PRIORITY) if (codes.includes(c)) return c;
  return codes[0] ?? 'requester';
}
