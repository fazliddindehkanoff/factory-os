/** Verify full freedom: delete ANY field (incl name/quantity) + create still works. Server up on :3100. */
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
  const before = (await get(owner, '/admin/form-fields')) as { id: string; key: string }[];
  const itemName = before.find((f) => f.key === 'itemName')!;
  const quantity = before.find((f) => f.key === 'quantity')!;

  // 1) Delete the previously-protected fields — now allowed.
  console.log('1) delete "itemName" -> HTTP', (await del(owner, itemName.id)).status, '| delete "quantity" -> HTTP', (await del(owner, quantity.id)).status, '(expect 200 / 200)');

  // 2) Create a request from a form WITHOUT name/quantity (custom-only).
  const r = await fetch(`${BASE}/api/requests`, {
    method: 'POST',
    headers: H(req),
    body: JSON.stringify({ requestType: 'service_request', priority: 'normal', customFields: {} }),
  });
  const body = (await r.json()) as { id?: string; requestNumber?: string };
  console.log('2) create with NO items -> HTTP', r.status, 'number:', body.requestNumber, '(expect 201)');

  // 3) Read it back — request exists, zero items.
  if (body.id) {
    const back = (await get(req, `/requests/${body.id}`)) as { items: unknown[]; status: string };
    console.log('3) read back -> items:', back.items.length, 'status:', back.status, '(expect 0 items / pending_approval)');
  }

  // restore the two default fields so the demo form stays complete
  console.log('   (restoring name/quantity via tenant:setup top-up next)');
}
main().catch((e) => { console.error(e); process.exit(1); });
