/**
 * Fail-closed guard for destructive maintenance scripts.
 *
 * Any script that deletes users / roles / requests / audit / stock MUST call
 * `assertWipeAllowed()` before touching data. The guard refuses to run unless
 * ALL of the following hold:
 *
 *   1. NODE_ENV is NOT 'production' (unset is treated as production — fail-closed).
 *   2. FORCE_WIPE=1 is set (deliberate opt-in).
 *   3. WIPE_TARGET_DB names the exact database in DATABASE_URL (typo-proofing so a
 *      stray production connection string cannot be wiped).
 *
 * Audit logs are preserved unless FORCE_DELETE_AUDIT=1 is ALSO set.
 *
 * The pure `evaluateWipeGuard()` is unit-tested; `assertWipeAllowed()` is the
 * process-level wrapper that prints guidance and exits non-zero on refusal.
 */

export interface WipeEnv {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  FORCE_WIPE?: string;
  WIPE_TARGET_DB?: string;
  FORCE_DELETE_AUDIT?: string;
}

export interface WipeDecision {
  ok: boolean;
  problems: string[];
  allowAuditDelete: boolean;
  dbName: string | null;
  nodeEnv: string;
}

/** Extract the database name from a postgres connection string, if parseable. */
export function dbNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const name = u.pathname.replace(/^\//, '').split('?')[0];
    return name || null;
  } catch {
    // Non-URL form (e.g. "host=... dbname=...") — try a dbname token.
    const m = /(?:dbname|database)=([^\s;]+)/i.exec(url);
    return m ? m[1] : null;
  }
}

/** Pure decision function — no side effects, safe to unit-test. */
export function evaluateWipeGuard(env: WipeEnv): WipeDecision {
  // Fail-closed: an unset NODE_ENV is treated as production.
  const nodeEnv = env.NODE_ENV ?? 'production';
  const dbName = dbNameFromUrl(env.DATABASE_URL);
  const problems: string[] = [];

  if (nodeEnv === 'production') {
    problems.push('NODE_ENV=production — destructive scripts are disabled in production (unset NODE_ENV counts as production).');
  }
  if (env.FORCE_WIPE !== '1') {
    problems.push('FORCE_WIPE=1 is required to run a destructive script.');
  }
  const target = env.WIPE_TARGET_DB;
  if (!target) {
    problems.push('WIPE_TARGET_DB must name the exact dev/test database you intend to wipe.');
  } else if (dbName && target !== dbName) {
    problems.push(`WIPE_TARGET_DB="${target}" does not match the database in DATABASE_URL ("${dbName}"). Refusing.`);
  }

  return {
    ok: problems.length === 0,
    problems,
    allowAuditDelete: env.FORCE_DELETE_AUDIT === '1',
    dbName,
    nodeEnv,
  };
}

/**
 * Enforce the guard at process level. On refusal: print every problem plus a
 * copy-paste example and exit(1). On success: print a loud warning and return
 * whether audit deletion is permitted this run.
 */
export function assertWipeAllowed(scriptName: string): WipeDecision {
  const decision = evaluateWipeGuard(process.env);

  if (!decision.ok) {
    console.error(`\n🛑  ${scriptName}: destructive run REFUSED.\n`);
    for (const p of decision.problems) console.error('   • ' + p);
    console.error(
      `\nTo run against a dev/test database ONLY:\n` +
        `  NODE_ENV=development FORCE_WIPE=1 WIPE_TARGET_DB=<dbname> \\\n` +
        `    npx tsx scripts/${scriptName}\n` +
        `Add FORCE_DELETE_AUDIT=1 only if you deliberately want to erase the audit log.\n`,
    );
    process.exit(1);
  }

  console.warn(
    `\n⚠️  ${scriptName}: DESTRUCTIVE run against database "${decision.dbName ?? '(unknown)'}" ` +
      `(NODE_ENV=${decision.nodeEnv}).`,
  );
  console.warn(
    `   Audit-log deletion: ${
      decision.allowAuditDelete ? 'ENABLED (FORCE_DELETE_AUDIT=1)' : 'DISABLED — audit preserved'
    }\n`,
  );
  return decision;
}
