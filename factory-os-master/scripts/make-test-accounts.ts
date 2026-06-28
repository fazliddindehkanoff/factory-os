/**
 * Creates real test users (random numeric Telegram IDs) so the active approval
 * workflow can be walked end-to-end: one user per role on the active workflow's
 * steps (and those roles get approval permissions), plus one request creator.
 * Server up on :3100.
 */
const BASE = 'http://localhost:3100';
const APPROVE_PERMS = ['approvals.view', 'approvals.approve', 'approvals.reject', 'requests.view'];
const randId = () => String(Math.floor(100000000 + Math.random() * 899999999));

async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();
const post = (t: string, p: string, b: unknown) => fetch(`${BASE}/api${p}`, { method: 'POST', headers: H(t), body: JSON.stringify(b) });
const put = (t: string, p: string, b: unknown) => fetch(`${BASE}/api${p}`, { method: 'PUT', headers: H(t), body: JSON.stringify(b) });

interface Role { id: string; code: string; name: string; permissions: string[] }

async function makeUser(owner: string, name: string, roleId: string): Promise<string> {
  const id = randId();
  const u = (await (await post(owner, '/admin/users/invite', { telegram_id: id, name })).json()) as { id?: string };
  if (u.id) await post(owner, `/admin/users/${u.id}/roles`, { roleId });
  return id;
}

async function main() {
  const owner = await tok('demo_owner');
  const wfs = (await get(owner, '/admin/workflows')) as { id: string; name: string; isActive?: boolean }[];
  const active = wfs.find((w) => w.isActive) ?? wfs[wfs.length - 1];
  const steps = (await get(owner, `/admin/workflows/${active.id}/steps`)) as { stepName?: string; name?: string; approverRoleId?: string; approver_role_id?: string }[];
  const roles = (await get(owner, '/admin/roles')) as Role[];
  const roleById = new Map(roles.map((r) => [r.id, r]));
  console.log('Активный workflow:', active.name);

  const seen = new Set<string>();
  const created: { id: string; role: string; steps: string[] }[] = [];
  for (const s of steps) {
    const rid = s.approverRoleId ?? s.approver_role_id;
    const role = rid ? roleById.get(rid) : undefined;
    if (!rid || !role || seen.has(rid)) continue;
    seen.add(rid);
    // grant approval permissions to this workflow role (merge with existing)
    const merged = [...new Set([...(role.permissions ?? []), ...APPROVE_PERMS])];
    await put(owner, `/admin/roles/${rid}/permissions`, { codes: merged });
    const stepNames = steps.filter((x) => (x.approverRoleId ?? x.approver_role_id) === rid).map((x) => x.stepName ?? x.name ?? '?');
    const id = await makeUser(owner, `${role.name} (тест)`, rid);
    created.push({ id, role: role.name, steps: stepNames });
  }

  // a request creator (system requester role)
  const requester = roles.find((r) => r.code === 'requester');
  let creatorId = '';
  if (requester) creatorId = await makeUser(owner, 'Заявитель (тест)', requester.id);

  console.log('\n=== ТЕСТОВЫЕ АККАУНТЫ (вход по этому ID) ===');
  if (creatorId) console.log(`  ${creatorId}  ->  Заявитель (создаёт заявки)`);
  for (const c of created) console.log(`  ${c.id}  ->  ${c.role}   (согласует: ${c.steps.join(', ')})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
