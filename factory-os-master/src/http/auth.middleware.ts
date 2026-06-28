/** Session-based authentication: Bearer <session token> → req.user. Fails closed. */
import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { verifySession } from '../auth/session.js';

export interface AuthedUser {
  id: string;
  holdingId: string | null;
  telegramId: string | null;
  fullName: string;
}

export interface AuthedRequest extends Request {
  user?: AuthedUser;
}

type Db = any;

export function requireAuth(db: Db, secret: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.header('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const payload = token ? verifySession(token, secret) : null;
      if (!payload) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, payload.uid));
      if (!u || u.status === 'disabled' || u.status === 'archived') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      (req as AuthedRequest).user = {
        id: u.id,
        holdingId: u.holdingId,
        telegramId: u.telegramId,
        fullName: u.fullName,
      };
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}
