/** Verifies the review fixes. Server must be up on :3100. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const post = (t: string, p: string, b: unknown) => fetch(`${BASE}/api${p}`, { method: 'POST', headers: H(t), body: JSON.stringify(b) });
const put = (t: string, p: string, b: unknown) => fetch(`${BASE}/api${p}`, { method: 'PUT', headers: H(t), body: JSON.stringify(b) });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();

async function newField(t: string, body: unknown) {
  return (await (await post(t, '/admin/form-fields', body)).json()) as { id: string; key: string };
}
async function makeReq(t: string, customFields: unknown, priority = 'normal') {
  const r = await post(t, '/requests', { title: 'T', requestType: 'material_request', priority, items: [{ name: 'X', quantity: 1, unitPrice: 0 }], customFields });
  return { status: r.status, body: (await r.json()) as { id?: string } };
}
const readCustom = async (t: string, id: string) => ((await get(t, `/requests/${id}`)) as { customFields: Record<string, unknown> | null }).customFields;

async function main() {
  const owner = await tok('demo_owner');
  const req = await tok('demo_requester');
  const A = await newField(owner, { label: 'Цвет', type: 'select', step: 2, options: [{ value: 'Белый', label: 'Белый' }, { value: 'Синий', label: 'Синий' }] });
  const B = await newField(owner, { label: 'Заметка', type: 'text', step: 2 });

  // 1) unknown key dropped, text trimmed, valid select kept
  const r1 = await makeReq(req, { [A.key]: 'Синий', [B.key]: '  привет  ', hacker: 'x', __proto__: 'y' });
  const c1 = await readCustom(req, r1.body.id!);
  console.log('1) sanitized customFields:', JSON.stringify(c1), '| keys:', c1 ? Object.keys(c1) : null);

  // 2) invalid select option dropped
  const r2 = await makeReq(req, { [A.key]: 'Розовый' });
  console.log('2) invalid select value -> stored:', JSON.stringify(await readCustom(req, r2.body.id!)), '(expect null)');

  // 3) array customFields rejected
  const r3 = await makeReq(req, ['a', 'b']);
  console.log('3) array customFields -> stored:', JSON.stringify(await readCustom(req, r3.body.id!)), '(expect null)');

  // 4) invalid priority whitelisted (no 500)
  const r4 = await makeReq(req, null, 'express');
  const p4 = ((await get(req, `/requests/${r4.body.id}`)) as { priority: string }).priority;
  console.log('4) priority "express" -> HTTP', r4.status, 'stored priority:', p4, '(expect 201 / normal)');

  // 5) system field protection
  const list = (await get(owner, '/admin/form-fields')) as { id: string; key: string }[];
  const itemName = list.find((f) => f.key === 'itemName')!;
  const unreq = await put(owner, `/admin/form-fields/${itemName.id}`, { required: false });
  const disable = await put(owner, `/admin/form-fields/${itemName.id}`, { enabled: false });
  console.log('5) itemName un-require -> HTTP', unreq.status, '| disable -> HTTP', disable.status, '(expect 400 / 400)');

  // cleanup
  await fetch(`${BASE}/api/admin/form-fields/${A.id}`, { method: 'DELETE', headers: H(owner) });
  await fetch(`${BASE}/api/admin/form-fields/${B.id}`, { method: 'DELETE', headers: H(owner) });
  console.log('cleanup done');
}
main().catch((e) => { console.error(e); process.exit(1); });
