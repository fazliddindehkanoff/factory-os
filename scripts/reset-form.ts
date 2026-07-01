/** Repair the request_create form: re-enable system fields and restore correct required flags. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();
const put = (t: string, id: string, b: unknown) => fetch(`${BASE}/api/admin/form-fields/${id}`, { method: 'PUT', headers: H(t), body: JSON.stringify(b) });

// Correct default `required` per system field.
const REQUIRED: Record<string, boolean> = { requestType: true, priority: true, itemName: true, quantity: true };

async function main() {
  const owner = await tok('demo_owner');
  const list = (await get(owner, '/admin/form-fields')) as { id: string; key: string; system: boolean }[];
  for (const f of list) {
    if (!f.system) continue;
    await put(owner, f.id, { enabled: true, required: REQUIRED[f.key] ?? false });
  }
  const after = (await get(owner, '/admin/form-fields')) as { key: string; system: boolean; required: boolean; enabled: boolean }[];
  console.log('repaired:');
  for (const f of after) console.log(`  ${f.key.padEnd(12)} sys=${String(f.system).padEnd(5)} req=${String(f.required).padEnd(5)} enabled=${f.enabled}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
