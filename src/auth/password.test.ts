import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('dashboard password hashing', () => {
  it('round-trips a password without storing it in plaintext', () => {
    const hash = hashPassword('correct horse battery staple', 'server-pepper');

    expect(hash).not.toContain('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash, 'server-pepper')).toBe(true);
    expect(verifyPassword('wrong', hash, 'server-pepper')).toBe(false);
  });

  it('fails closed for invalid hashes and a different pepper', () => {
    const hash = hashPassword('password', 'pepper-a');

    expect(verifyPassword('password', hash, 'pepper-b')).toBe(false);
    expect(verifyPassword('password', 'not-a-hash', 'pepper-a')).toBe(false);
    expect(verifyPassword('password', null, 'pepper-a')).toBe(false);
  });
});
