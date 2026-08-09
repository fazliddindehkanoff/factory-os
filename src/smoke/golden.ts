/**
 * Local golden-path smoke — `npm run smoke:golden`.
 *
 * Boots the REAL Express app over an in-memory PGlite database (the same engine
 * the test suite uses) and drives the pilot golden path over real HTTP, exactly
 * as the Mini App would. No production DB, no local PostgreSQL, no real Telegram:
 * dev-auth is enabled only for this in-process harness.
 *
 * Exits 0 if every assertion passes, 1 otherwise (CI-friendly).
 *
 * Covers: create → approve(PIN) → warehouse check → issue → close;
 * stock decremented once; wrong/missing PIN rejected; self-approval rejected;
 * action on the wrong step rejected.
 *
 * See docs/SMOKE_LOCAL.md.
 */
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema.js';
import { seedPilot, PILOT_PIN } from '../db/seed-pilot.js';
import { createApp } from '../server/app.js';

// ── tiny assertion harness ───────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<number> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const { materials } = await seedPilot(db);

  const app = createApp({
    db,
    botToken: 'smoke-bot-token',
    sessionSecret: 'smoke-session-secret-0123456789',
    devAuth: true, // in-process harness only — never the production server
      });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api`;

  async function api(
    path: string,
    { method = 'GET', token, body }: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<{ status: number; data: any }> {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let data: any;
    try { data = JSON.parse(txt); } catch { data = txt; }
    return { status: r.status, data };
  }
  const login = async (tg: string): Promise<string> =>
    (await api('/auth/dev', { method: 'POST', body: { telegramId: tg } })).data.token;
  const action = (id: string, token: string, body: Record<string, unknown>) =>
    api(`/requests/${id}/action`, { method: 'POST', token, body });

  console.log('factory-os — local golden-path smoke (in-memory PGlite, real HTTP)\n');

  const requester = await login('pilot_requester');
  const director = await login('pilot_director');
  const warehouse = await login('pilot_warehouse');
  check('dev-auth issues tokens for all three pilot roles', !!(requester && director && warehouse));

  // material + initial stock from warehouse balances
  const bals = (await api('/warehouse/balances', { token: warehouse })).data as any[];
  const bearing = bals.find((b) => b.materialName?.includes(materials.inStock.name));
  const stockBefore = bearing ? Number(bearing.availableQty) : NaN;
  check('initial stock is 100', stockBefore === 100, `got ${stockBefore}`);

  // 1) requester creates
  const created = await api('/requests', {
    method: 'POST', token: requester,
    body: { title: 'Smoke: подшипники', items: [{ name: bearing.materialName, materialId: bearing.materialId, quantity: 5, unitPrice: 1000 }] },
  });
  const id = created.data.id;
  check('create request → 201 pending_approval', created.status === 201 && created.data.status === 'pending_approval', `HTTP ${created.status} status ${created.data.status}`);

  // 2) security: self-approval rejected
  const self = await action(id, requester, { action: 'approve', pin: PILOT_PIN });
  check('requester cannot approve own request → 403', self.status === 403, `HTTP ${self.status}`);

  // 3) security: wrong / missing PIN rejected
  const wrong = await action(id, director, { action: 'approve', pin: '0000' });
  check('wrong PIN rejected → 403', wrong.status === 403, `HTTP ${wrong.status}`);
  const noPin = await action(id, director, { action: 'approve' });
  check('missing PIN rejected → 403', noPin.status === 403, `HTTP ${noPin.status}`);

  // 4) director approves with correct PIN
  const ok = await action(id, director, { action: 'approve', pin: PILOT_PIN });
  check('director approve (PIN) → warehouse_check', ok.status === 200 && ok.data.status === 'warehouse_check', `HTTP ${ok.status} status ${ok.data.status}`);

  // 5) security: action on wrong step rejected
  const wrongStep = await action(id, director, { action: 'approve', pin: PILOT_PIN });
  check('re-approve after advance (wrong step) → 400', wrongStep.status === 400, `HTTP ${wrongStep.status}`);

  // 6) warehouse confirms stock → issue
  const whIn = await action(id, warehouse, { action: 'wh_in_stock' });
  check('warehouse wh_in_stock → issue', whIn.status === 200 && whIn.data.status === 'issue', `HTTP ${whIn.status} status ${whIn.data.status}`);

  // 7) warehouse issues → close
  const issue = await action(id, warehouse, { action: 'issue' });
  check('warehouse issue → close', issue.status === 200 && issue.data.status === 'close', `HTTP ${issue.status} status ${issue.data.status}`);

  // 8) stock decremented exactly once (100 → 95)
  const bals2 = (await api('/warehouse/balances', { token: warehouse })).data as any[];
  const stockAfter = Number(bals2.find((b) => b.materialId === bearing.materialId)?.availableQty);
  check('stock decremented once (100 → 95)', stockAfter === 95, `got ${stockAfter}`);

  // 9) requester closes
  const close = await action(id, requester, { action: 'close' });
  check('requester close → closed (workflow done)', close.status === 200 && close.data.status === 'closed' && close.data.currentStepId === null, `HTTP ${close.status} status ${close.data.status}`);

  server.close();
  try { await client.close(); } catch { /* ignore */ }

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('failed: ' + failures.join('; '));
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error('smoke crashed:', err); process.exitCode = 1; },
);
