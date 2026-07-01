/** End-to-end check of the request lifecycle vertical. Server up on :3100. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();
const act = (t: string, id: string, body: unknown) => fetch(`${BASE}/api/requests/${id}/action`, { method: 'POST', headers: H(t), body: JSON.stringify(body) });
const acts = (d: { actions?: { action: string }[] }) => (d.actions ?? []).map((a) => a.action).join(',') || '∅';

async function newReq(t: string): Promise<string> {
  const r = await (await fetch(`${BASE}/api/requests`, { method: 'POST', headers: H(t), body: JSON.stringify({ title: 'LC', requestType: 'material_request', priority: 'normal', items: [{ name: 'X', quantity: 1, unitPrice: 1000000 }] }) })).json();
  return r.id;
}

async function main() {
  const requester = await tok('demo_requester');
  const warehouse = await tok('demo_warehouse');
  const procurement = await tok('demo_procurement');
  const director = await tok('demo_director');

  // ── Branch A: in stock → reserve → approve (PIN) ──
  const a = await newReq(requester);
  const a0 = await get(requester, `/requests/${a}`);
  console.log('A) создана, статус:', a0.status, '| действия у ЗАЯВИТЕЛЯ:', acts(a0), '(ожидаем ∅ — нет прав склада)');
  const aWh = await get(warehouse, `/requests/${a}`);
  console.log('   действия у СКЛАДА:', acts(aWh), '(ожидаем wh_*)');
  console.log('   wh_in_stock ->', (await act(warehouse, a, { action: 'wh_in_stock' })).status);
  console.log('   reserve ->', (await act(warehouse, a, { action: 'reserve' })).status, '(теперь approval_pending)');
  // director sets PIN, then approve flows
  console.log('   director set PIN ->', (await fetch(`${BASE}/api/me/pin`, { method: 'POST', headers: H(director), body: JSON.stringify({ pin: '1234' }) })).status);
  console.log('   approve БЕЗ pin ->', (await act(director, a, { action: 'approve' })).status, '(ожидаем 403)');
  console.log('   approve НЕВЕРНЫЙ pin ->', (await act(director, a, { action: 'approve', pin: '0000' })).status, '(ожидаем 403)');
  const ok = await act(director, a, { action: 'approve', pin: '1234' });
  const aFin = await ok.json();
  console.log('   approve ВЕРНЫЙ pin ->', ok.status, '| статус:', aFin.status, '(ожидаем 200 / approved)');

  // ── Branch B: out of stock → procurement → quote → supplier → approve ──
  const b = await newReq(requester);
  await act(warehouse, b, { action: 'wh_out' });
  await act(warehouse, b, { action: 'to_procurement' });
  const bProc = await get(procurement, `/requests/${b}`);
  console.log('B) у ЗАКУПЩИКА в статусе procurement действия:', acts(bProc), '(ожидаем add_quotation)');
  await act(procurement, b, { action: 'add_quotation' });
  await act(procurement, b, { action: 'select_supplier' });
  const bAfter = await get(procurement, `/requests/${b}`);
  console.log('   после select_supplier статус:', bAfter.status, '(ожидаем approval_pending)');
  const bOk = await act(director, b, { action: 'approve', pin: '1234' });
  console.log('   director approve ->', bOk.status, '| статус:', (await bOk.json()).status);

  // ── Status history + scope gating ──
  const hist = await get(director, `/requests/${a}`);
  console.log('История статусов A:', (hist.statusHistory ?? []).map((h: { newStatus: string }) => h.newStatus).join(' → '));
  // wrong-status guard: try reserve on an already-approved request
  console.log('Защита перехода (reserve по approved) ->', (await act(warehouse, a, { action: 'reserve' })).status, '(ожидаем 409)');
}
main().catch((e) => { console.error(e); process.exit(1); });
