/** Verify: admin can edit the choice-buttons of a SYSTEM select ("Тип заявки"), values preserved. Server up on :3100. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();
const put = (t: string, id: string, b: unknown) => fetch(`${BASE}/api/admin/form-fields/${id}`, { method: 'PUT', headers: H(t), body: JSON.stringify(b) });
type O = { value: string; label: string };

async function main() {
  const owner = await tok('demo_owner');
  const req = await tok('demo_requester');
  const list = (await get(owner, '/admin/form-fields')) as { id: string; key: string; options: O[] }[];
  const rt = list.find((f) => f.key === 'requestType')!;
  const original = rt.options;
  console.log('before:', original.map((o) => `${o.label}=${o.value}`).join(', '));

  // Edit: rename "Материал" -> "Материалы" (keep its value), add a new button "Канцелярия".
  const edited: O[] = [
    ...original.map((o) => (o.label === 'Материал' ? { value: o.value, label: 'Материалы' } : o)),
    { value: '', label: 'Канцелярия' },
  ];
  console.log('PUT options ->', (await put(owner, rt.id, { options: edited })).status, '(expect 200)');

  const after = ((await get(owner, '/admin/form-fields')) as { key: string; options: O[] }[]).find((f) => f.key === 'requestType')!.options;
  console.log('after: ', after.map((o) => `${o.label}=${o.value}`).join(', '));
  console.log('value of "Материалы" preserved as material_request?', after.find((o) => o.label === 'Материалы')?.value === 'material_request');

  // The new button works for creating a request (text column accepts it).
  const newVal = after.find((o) => o.label === 'Канцелярия')!.value;
  const mk = await fetch(`${BASE}/api/requests`, { method: 'POST', headers: H(req), body: JSON.stringify({ title: 'Ручки', requestType: newVal, priority: 'normal', items: [{ name: 'Ручки', quantity: 10, unitPrice: 0 }] }) });
  console.log('create with new type "Канцелярия" ->', mk.status, '(expect 201)');

  // restore original buttons
  await put(owner, rt.id, { options: original });
  console.log('restored original buttons');
}
main().catch((e) => { console.error(e); process.exit(1); });
