/**
 * Normalizes a phone number to a digits-only canonical form (e.g. "998901234567"),
 * used both as the stored `users.phone` value and, when no explicit username is
 * given, as the dashboard `username`. Local Uzbek numbers (9 digits, or 10 digits
 * with a leading trunk "0") are given the "998" country code; anything else is
 * returned as digits-only, unprefixed.
 */
export function normalizePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 9) return `998${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `998${digits.slice(1)}`;
  return digits;
}
