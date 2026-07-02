import { describe, it, expect } from 'vitest';
import { evaluateWipeGuard, dbNameFromUrl } from '../../scripts/_wipe-guard.js';

const OK_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/factory_dev',
  FORCE_WIPE: '1',
  WIPE_TARGET_DB: 'factory_dev',
};

describe('wipe guard', () => {
  it('extracts db name from a URL connection string', () => {
    expect(dbNameFromUrl('postgresql://u:p@host:5432/factory_dev?sslmode=require')).toBe('factory_dev');
    expect(dbNameFromUrl('postgres://host/mydb')).toBe('mydb');
    expect(dbNameFromUrl('host=x dbname=kv_test')).toBe('kv_test');
    expect(dbNameFromUrl(undefined)).toBeNull();
  });

  it('allows a fully-specified dev wipe', () => {
    const d = evaluateWipeGuard(OK_ENV);
    expect(d.ok).toBe(true);
    expect(d.problems).toHaveLength(0);
    expect(d.allowAuditDelete).toBe(false);
  });

  it('refuses when NODE_ENV=production', () => {
    const d = evaluateWipeGuard({ ...OK_ENV, NODE_ENV: 'production' });
    expect(d.ok).toBe(false);
    expect(d.problems.join(' ')).toMatch(/production/i);
  });

  it('treats unset NODE_ENV as production (fail-closed)', () => {
    const d = evaluateWipeGuard({ ...OK_ENV, NODE_ENV: undefined });
    expect(d.ok).toBe(false);
    expect(d.problems.join(' ')).toMatch(/production/i);
  });

  it('refuses without FORCE_WIPE=1', () => {
    const d = evaluateWipeGuard({ ...OK_ENV, FORCE_WIPE: undefined });
    expect(d.ok).toBe(false);
    expect(d.problems.join(' ')).toMatch(/FORCE_WIPE/);
  });

  it('refuses without WIPE_TARGET_DB', () => {
    const d = evaluateWipeGuard({ ...OK_ENV, WIPE_TARGET_DB: undefined });
    expect(d.ok).toBe(false);
    expect(d.problems.join(' ')).toMatch(/WIPE_TARGET_DB/);
  });

  it('refuses when WIPE_TARGET_DB does not match the actual database', () => {
    const d = evaluateWipeGuard({ ...OK_ENV, WIPE_TARGET_DB: 'production_db' });
    expect(d.ok).toBe(false);
    expect(d.problems.join(' ')).toMatch(/does not match/i);
  });

  it('keeps audit deletion off unless FORCE_DELETE_AUDIT=1', () => {
    expect(evaluateWipeGuard(OK_ENV).allowAuditDelete).toBe(false);
    expect(evaluateWipeGuard({ ...OK_ENV, FORCE_DELETE_AUDIT: '1' }).allowAuditDelete).toBe(true);
  });
});
