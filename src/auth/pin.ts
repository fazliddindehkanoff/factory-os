/** PIN hashing for sign-off — scrypt + random salt + server-side pepper (PIN_PEPPER). */
import crypto from 'node:crypto';

const DEFAULT_PEPPER = process.env.PIN_PEPPER ?? '';

export function hashPin(pin: string, pepper: string = DEFAULT_PEPPER): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pin) + pepper, salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string | null | undefined, pepper: string = DEFAULT_PEPPER): boolean {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const dk = crypto.scryptSync(String(pin || '') + pepper, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}
