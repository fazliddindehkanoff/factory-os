/** PIN hashing for sign-off — scrypt + random salt + server-side pepper (PIN_PEPPER). */
import crypto from 'node:crypto';

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const pepper = process.env.PIN_PEPPER || '';
  const dk = crypto.scryptSync(String(pin) + pepper, salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  try {
    const [, saltHex, hashHex] = stored.split('$');
    const pepper = process.env.PIN_PEPPER || '';
    const dk = crypto.scryptSync(String(pin || '') + pepper, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}
