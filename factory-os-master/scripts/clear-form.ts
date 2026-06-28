/** Clears every field from the request_create form (blank slate). Server up on :3100. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

async function main() {
  const owner = await tok('demo_owner');
  let remaining = Infinity;
  // Loop because a transient Neon error could skip a field; repeat until empty.
  for (let pass = 0; pass < 5 && remaining !== 0; pass++) {
    const list = (await (await fetch(`${BASE}/api/admin/form-fields`, { headers: H(owner) })).json()) as { id: string }[];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      await fetch(`${BASE}/api/admin/form-fields/${f.id}`, { method: 'DELETE', headers: H(owner) });
    }
    const after = (await (await fetch(`${BASE}/api/admin/form-fields`, { headers: H(owner) })).json()) as unknown[];
    remaining = Array.isArray(after) ? after.length : -1;
    console.log(`pass ${pass + 1}: remaining = ${remaining}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
