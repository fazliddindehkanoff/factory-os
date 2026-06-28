/**
 * Telegram WebApp initData verification.
 *
 * Hardened version of the legacy check: validates the HMAC in constant time AND
 * rejects stale initData (replay protection via auth_date). Returns the parsed
 * Telegram user on success, or null on any failure (fails closed).
 */
import crypto from 'node:crypto';

export interface TelegramUser {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 86400,
): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.keys()]
      .sort()
      .map((k) => `${k}=${params.get(k)}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    // Replay protection: reject initData older than maxAgeSec (auth_date is unix seconds).
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate)) return null;
    const ageSec = Date.now() / 1000 - authDate;
    if (ageSec > maxAgeSec || ageSec < -300) return null; // allow 5 min skew, reject far-future

    const userRaw = params.get('user');
    if (!userRaw) return null;
    const u = JSON.parse(userRaw) as {
      id?: number | string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    if (u?.id == null) return null;

    return {
      id: String(u.id),
      firstName: u.first_name,
      lastName: u.last_name,
      username: u.username,
    };
  } catch {
    return null;
  }
}
