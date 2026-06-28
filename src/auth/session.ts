/**
 * Short-lived server session tokens.
 *
 * After Telegram initData is verified once, we issue a signed, expiring session
 * token instead of replaying the long-lived initData on every request. Format:
 *   base64url(JSON payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))
 * Dependency-free (Node crypto); verified in constant time.
 */
import crypto from 'node:crypto';

export interface SessionPayload {
  uid: string; // users.id (uuid)
  exp: number; // unix seconds
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

export function issueSession(uid: string, secret: string, ttlSec = 3600): string {
  const payload: SessionPayload = { uid, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  try {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = sign(body, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
