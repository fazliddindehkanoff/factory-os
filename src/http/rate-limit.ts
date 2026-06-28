/**
 * Rate limiting and PIN brute-force protection.
 *
 * - Auth endpoints: 10 req/min per IP (login attempts).
 * - PIN verification: 5 failures per user → 15 min lockout.
 * - General API: 120 req/min per IP.
 */
import rateLimit from 'express-rate-limit';

/** General API rate limiter: 120 req/min per IP. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — try again in a minute' },
});

/** Auth endpoints: 10 attempts/min per IP. */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again later' },
});

/**
 * In-memory PIN lockout: tracks failed PIN attempts per userId.
 * After MAX_FAILURES within WINDOW_MS the user is locked out for LOCKOUT_MS.
 * Simple Map — survives only within a single process; a restart clears it
 * (acceptable: it's a safety net, not the only guard).
 */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000; // 15 min
const WINDOW_MS = 10 * 60_000; // 10 min window for counting failures

interface PinRecord {
  failures: number;
  firstFailAt: number;
  lockedUntil: number;
}

const pinAttempts = new Map<string, PinRecord>();

/** Check if a user is currently locked out. Returns ms remaining, or 0. */
export function pinLockoutRemaining(userId: string): number {
  const rec = pinAttempts.get(userId);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockedUntil > now) return rec.lockedUntil - now;
  // If window expired, reset
  if (now - rec.firstFailAt > WINDOW_MS) {
    pinAttempts.delete(userId);
    return 0;
  }
  return 0;
}

/** Record a failed PIN attempt. Returns true if the user is now locked out. */
export function recordPinFailure(userId: string): boolean {
  const now = Date.now();
  let rec = pinAttempts.get(userId);
  if (!rec || now - rec.firstFailAt > WINDOW_MS) {
    rec = { failures: 1, firstFailAt: now, lockedUntil: 0 };
    pinAttempts.set(userId, rec);
    return false;
  }
  rec.failures += 1;
  if (rec.failures >= MAX_FAILURES) {
    rec.lockedUntil = now + LOCKOUT_MS;
    return true;
  }
  return false;
}

/** Clear PIN failure record on successful verification. */
export function clearPinFailures(userId: string): void {
  pinAttempts.delete(userId);
}
