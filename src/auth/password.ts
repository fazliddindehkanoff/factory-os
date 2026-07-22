/** Password hashing for dashboard accounts — scrypt + random salt + server pepper. */
import crypto from 'node:crypto';

const KEY_BYTES = 64;

export function hashPassword(password: string, pepper: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password) + pepper, salt, KEY_BYTES);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined, pepper: string): boolean {
  if (!stored?.startsWith('scrypt$')) return false;
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const derived = crypto.scryptSync(String(password || '') + pepper, Buffer.from(saltHex, 'hex'), KEY_BYTES);
    const expected = Buffer.from(hashHex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
