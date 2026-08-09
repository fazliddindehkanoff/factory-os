/**
 * In-memory PIN brute-force protection.
 *
 * Tracks failed PIN attempts per user. After five failures within the window,
 * PIN-protected actions are locked for 15 minutes. This is independent from
 * HTTP request throttling and intentionally remains as an account-level safety
 * control.
 */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const WINDOW_MS = 10 * 60_000;

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

/** Clear PIN failure state after successful verification. */
export function clearPinFailures(userId: string): void {
  pinAttempts.delete(userId);
}
