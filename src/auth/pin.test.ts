import { describe, it, expect } from 'vitest';
import { hashPin, verifyPin } from './pin.js';

describe('PIN hashing', () => {
  it('hashPin returns a string with scrypt$salt$hash format', () => {
    const h = hashPin('1234');
    expect(typeof h).toBe('string');
    expect(h.startsWith('scrypt$')).toBe(true);
    const parts = h.split('$');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1].length).toBeGreaterThan(0); // salt hex
    expect(parts[2].length).toBeGreaterThan(0); // hash hex
  });

  it('verifyPin returns true for correct PIN', () => {
    const h = hashPin('5678');
    expect(verifyPin('5678', h)).toBe(true);
  });

  it('verifyPin returns false for wrong PIN', () => {
    const h = hashPin('1234');
    expect(verifyPin('0000', h)).toBe(false);
  });

  it('verifyPin returns false for empty PIN', () => {
    const h = hashPin('1234');
    expect(verifyPin('', h)).toBe(false);
  });

  it('verifyPin returns false for null/undefined stored hash', () => {
    expect(verifyPin('1234', null)).toBe(false);
    expect(verifyPin('1234', undefined)).toBe(false);
  });

  it('verifyPin returns false for malformed stored hash', () => {
    expect(verifyPin('1234', 'not-a-valid-hash')).toBe(false);
    expect(verifyPin('1234', 'scrypt$')).toBe(false);
  });

  it('different PINs produce different hashes', () => {
    const h1 = hashPin('1234');
    const h2 = hashPin('5678');
    expect(h1).not.toBe(h2);
  });

  it('same PIN with different salts produces different hashes', () => {
    const h1 = hashPin('1234');
    const h2 = hashPin('1234');
    expect(h1).not.toBe(h2); // random salt
    expect(verifyPin('1234', h1)).toBe(true);
    expect(verifyPin('1234', h2)).toBe(true);
  });

  it('custom pepper changes the hash', () => {
    const h1 = hashPin('1234', 'pepper1');
    const h2 = hashPin('1234', 'pepper2');
    expect(verifyPin('1234', h1, 'pepper1')).toBe(true);
    expect(verifyPin('1234', h1, 'pepper2')).toBe(false);
  });
});
