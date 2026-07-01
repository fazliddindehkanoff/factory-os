/** Verify: delete any field (except load-bearing) + dynamic steps. Server up on :3100. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();
const del = (t: string, id: string) => fetch(`${BASE}/api/admin/form-fields/${id}`, { method: 'DELETE', headers: H(t) });

async function main() {
  const owner = await tok('demo_owner');
  const req = await tok('demo_requester');
  const list = (await get(owner, '/admin/form-fields')) as { id: string; key: string; system: boolean }[];

  // 1) Load-bearing system field stays protected.
  const itemName = list.find((f) => f.key === 'itemName')!;
  console.log('1) delete load-bearing "itemName" -> HTTP', (await del(owner, itemName.id)).status, '(expect 409)');

  // 2) Non-load-bearing SYSTEM field is now deletable (restored afterwards via tenant:setup).
  const note = list.find((f) => f.key === 'note')!;
  console.log('2) delete system "note" -> HTTP', (await del(owner, note.id)).status, '(expect 200)');

  // 3) Add a field on a NEW step 3 -> wizard schema gains step 3.
  const created = (await (await fetch(`${BASE}/api/admin/form-fields`, { method: 'POST', headers: H(owner), body: JSON.stringify({ label: 'Согласовано с отделом', type: 'checkbox', step: 3 }) })).json()) as { id: string; step: number };
  const form = (await get(req, '/form/request_create')) as { fields: { step: number }[] };
  console.log('3) added field on step', created.step, '| steps now:', [...new Set(form.fields.map((f) => f.step))].sort((a, b) => a - b).join(','), '(expect ...,3)');

  // 4) Create still works after a system field was deleted.
  const mk = await fetch(`${BASE}/api/requests`, { method: 'POST', headers: H(req), body: JSON.stringify({ title: 'Z', requestType: 'material_request', priority: 'normal', items: [{ name: 'Z', quantity: 2, unitPrice: 0 }], customFields: { [created.id]: true } }) });
  console.log('4) create after deletion -> HTTP', mk.status, '(expect 201)');

  await del(owner, created.id); // remove the demo step-3 field
  console.log('cleanup: demo step-3 field removed');
}
main().catch((e) => { console.error(e); process.exit(1); });
