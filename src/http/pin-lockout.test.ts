import { describe, it, expect, beforeEach } from 'vitest';
import { pinLockoutRemaining, recordPinFailure, clearPinFailures } from './rate-limit.js';

describe('PIN lockout', () => {
  const userId = 'test-user-lockout';

  beforeEach(() => {
    clearPinFailures(userId);
  });

  it('no lockout initially', () => {
    expect(pinLockoutRemaining(userId)).toBe(0);
  });

  it('1-4 failures do not lock', () => {
    for (let i = 0; i < 4; i++) {
      const locked = recordPinFailure(userId);
      expect(locked).toBe(false);
      expect(pinLockoutRemaining(userId)).toBe(0);
    }
  });

  it('5th failure triggers lockout', () => {
    for (let i = 0; i < 4; i++) recordPinFailure(userId);
    const locked = recordPinFailure(userId);
    expect(locked).toBe(true);
    expect(pinLockoutRemaining(userId)).toBeGreaterThan(0);
  });

  it('clearPinFailures resets lockout', () => {
    for (let i = 0; i < 5; i++) recordPinFailure(userId);
    expect(pinLockoutRemaining(userId)).toBeGreaterThan(0);
    clearPinFailures(userId);
    expect(pinLockoutRemaining(userId)).toBe(0);
  });

  it('different users have independent counters', () => {
    for (let i = 0; i < 5; i++) recordPinFailure('user-a');
    expect(pinLockoutRemaining('user-a')).toBeGreaterThan(0);
    expect(pinLockoutRemaining('user-b')).toBe(0);
    // cleanup
    clearPinFailures('user-a');
  });
});
