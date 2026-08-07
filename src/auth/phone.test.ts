import { describe, it, expect } from 'vitest';
import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('prefixes a 9-digit local number with 998', () => {
    expect(normalizePhone('901234567')).toBe('998901234567');
  });

  it('strips a leading trunk 0 from a 10-digit local number and prefixes 998', () => {
    expect(normalizePhone('0901234567')).toBe('998901234567');
  });

  it('strips formatting characters around an already-prefixed number', () => {
    expect(normalizePhone('+998 90 123 45 67')).toBe('998901234567');
  });

  it('leaves an already-normalized digits-only number unchanged', () => {
    expect(normalizePhone('998901234567')).toBe('998901234567');
  });

  it('returns digits-only for a non-UZ-shaped number without guessing a country code', () => {
    expect(normalizePhone('+1 415 555 0100')).toBe('14155550100');
  });

  it('handles empty input', () => {
    expect(normalizePhone('')).toBe('');
  });
});
