import { describe, it, expect, afterEach } from 'vitest';
import { loadEnv, devAuthEnabled } from './env.js';

/**
 * Fail-closed dev-auth gate (P0 security hardening).
 * Regression guard for the production hole where /api/auth/dev answered 200:
 * an unset NODE_ENV must resolve to 'production' and keep dev auth OFF.
 */

const KEYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'PIN_PEPPER',
  'SERVE_DESIGN',
  'NODE_ENV',
  'ENABLE_DEV_AUTH',
  'BOT_TOKEN',
  'APP_URL',
  'PORT',
];

const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function setEnv(over: Record<string, string | undefined>): void {
  const base: Record<string, string | undefined> = {
    DATABASE_URL: 'postgresql://u:p@localhost/db',
    SESSION_SECRET: 'a'.repeat(32),
    PIN_PEPPER: 'b'.repeat(32),
    SERVE_DESIGN: '0',
  };
  const merged = { ...base, ...over };
  for (const k of KEYS) {
    if (merged[k] === undefined) delete process.env[k];
    else process.env[k] = merged[k];
  }
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('dev-auth env gate (fail-closed)', () => {
  it('production + ENABLE_DEV_AUTH unset → dev auth OFF', () => {
    setEnv({ NODE_ENV: 'production', ENABLE_DEV_AUTH: undefined });
    expect(devAuthEnabled(loadEnv())).toBe(false);
  });

  it('production + ENABLE_DEV_AUTH=1 → refuses to boot', () => {
    setEnv({ NODE_ENV: 'production', ENABLE_DEV_AUTH: '1' });
    expect(() => loadEnv()).toThrow(/ENABLE_DEV_AUTH/);
  });

  it('development + ENABLE_DEV_AUTH=1 → dev auth ON', () => {
    setEnv({ NODE_ENV: 'development', ENABLE_DEV_AUTH: '1' });
    expect(devAuthEnabled(loadEnv())).toBe(true);
  });

  it('development + ENABLE_DEV_AUTH unset → dev auth OFF', () => {
    setEnv({ NODE_ENV: 'development', ENABLE_DEV_AUTH: undefined });
    expect(devAuthEnabled(loadEnv())).toBe(false);
  });

  it('NODE_ENV unset + ENABLE_DEV_AUTH=1 → blocked (the prod-hole regression)', () => {
    setEnv({ NODE_ENV: undefined, ENABLE_DEV_AUTH: '1' });
    expect(() => loadEnv()).toThrow(/ENABLE_DEV_AUTH/);
  });

  it('NODE_ENV unset → resolves to production', () => {
    setEnv({ NODE_ENV: undefined, ENABLE_DEV_AUTH: undefined });
    expect(loadEnv().NODE_ENV).toBe('production');
  });
});
