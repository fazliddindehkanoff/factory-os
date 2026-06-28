/** Diagnose why demo_dept_head cannot approve. Server up on :3100. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();

async function main() {
  const requester = await tok('demo_requester');
  const deptHead = await tok('demo_dept_head');

  // who is who
  const meR = (await get(requester, '/me')) as { user: { id: string } };
  const meD = (await get(deptHead, '/me')) as { user: { id: string }; permissions: string[] };
  console.log('requester id:', meR.user.id);
  console.log('dept_head id:', meD.user.id, '| has approvals.approve:', meD.permissions.includes('approvals.approve'));

  // create a request as requester (with an item so it has a real amount)
  const made = (await (await fetch(`${BASE}/api/requests`, { method: 'POST', headers: H(requester), body: JSON.stringify({ title: 'Diag', requestType: 'material_request', priority: 'normal', items: [{ name: 'X', quantity: 1, unitPrice: 1000000 }] }) })).json()) as { id: string; requestNumber: string };
  console.log('created:', made.requestNumber, made.id);

  // detail -> pending approval
  const det = (await get(deptHead, `/requests/${made.id}`)) as { status: string; approvals: { id: string; status: string }[] };
  console.log('request status:', det.status, '| approvals:', JSON.stringify(det.approvals));
  const pending = det.approvals.find((a) => a.status === 'pending');
  if (!pending) { console.log('NO pending approval'); return; }

  // try to approve as dept_head
  const r = await fetch(`${BASE}/api/approvals/${pending.id}/approve`, { method: 'POST', headers: H(deptHead), body: JSON.stringify({ comment: 'ok' }) });
  console.log('approve as dept_head ->', r.status, JSON.stringify(await r.json()));
}
main().catch((e) => { console.error(e); process.exit(1); });
