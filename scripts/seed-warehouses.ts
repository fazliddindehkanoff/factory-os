/**
 * One-off: clean up corrupted warehouses and seed correctly-encoded ones via the
 * HTTP API using Node fetch (UTF-8 native). Run while the server is up on :3100.
 *   npx tsx scripts/seed-warehouses.ts
 */
const BASE = 'http://localhost:3100';
const FACTORY_ID = 'f5d0ea62-2eb3-4ce3-a244-2bc08114395f';
const NAMES = ['Склад А', 'Склад Б', 'Склад сырья'];

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramId: 'demo_owner' }),
  });
  const { token } = (await loginRes.json()) as { token: string };
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Delete every existing (corrupted) warehouse.
  const before = (await (await fetch(`${BASE}/api/config`, { headers: H })).json()) as {
    warehouses: { id: string; name: string }[];
  };
  for (const w of before.warehouses) {
    const r = await fetch(`${BASE}/api/admin/warehouses/${w.id}`, { method: 'DELETE', headers: H });
    console.log('delete', w.id, r.status);
  }

  // Recreate with correct UTF-8 names.
  for (const name of NAMES) {
    const r = await fetch(`${BASE}/api/admin/warehouses`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ name, factory_id: FACTORY_ID }),
    });
    console.log('create', name, r.status);
  }

  // Verify by codepoints (terminal-independent). "Склад" = 421 43a 43b 430 434.
  const after = (await (await fetch(`${BASE}/api/config`, { headers: H })).json()) as {
    warehouses: { id: string; name: string }[];
  };
  for (const w of after.warehouses) {
    const cps = [...w.name].map((c) => c.codePointAt(0)!.toString(16)).join(' ');
    console.log('VERIFY:', JSON.stringify(w.name), '=>', cps);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
