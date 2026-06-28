/** Compare the approval step's approver role vs demo_dept_head's actual roles. */
const BASE = 'http://localhost:3100';
async function tok(id: string) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ telegramId: id }) });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const get = async (t: string, p: string) => (await fetch(`${BASE}/api${p}`, { headers: H(t) })).json();

async function main() {
  const owner = await tok('demo_owner');

  // active workflow + steps
  const wfs = (await get(owner, '/admin/workflows')) as { id: string; name: string; isActive?: boolean }[];
  console.log('workflows:', wfs.map((w) => `${w.name}${w.isActive ? '*' : ''}`).join(', '));
  for (const w of wfs) {
    const steps = (await get(owner, `/admin/workflows/${w.id}/steps`)) as { id: string; stepName?: string; name?: string; approverRoleId?: string; approver_role_id?: string; stepOrder?: number; order_index?: number }[];
    console.log(`workflow "${w.name}" steps:`);
    for (const s of steps) {
      console.log(`   step ${s.id.slice(0, 8)} order=${s.stepOrder ?? s.order_index} name="${s.stepName ?? s.name}" approverRoleId=${(s.approverRoleId ?? s.approver_role_id ?? 'null')}`);
    }
  }

  // all roles (id -> name/code)
  const roles = (await get(owner, '/admin/roles')) as { id: string; code: string; name: string }[];
  const roleName = (id: string) => roles.find((r) => r.id === id);
  console.log('--- dept_head system role ---');
  const sysDept = roles.find((r) => r.code === 'dept_head');
  console.log('system dept_head role id:', sysDept?.id, 'name:', sysDept?.name);

  // demo_dept_head user id + roles
  const users = (await get(owner, '/admin/users')) as { id: string; telegramId: string }[];
  const dh = users.find((u) => u.telegramId === 'demo_dept_head')!;
  const dhRoles = (await get(owner, `/admin/users/${dh.id}/roles`)) as { roleId?: string; id?: string; role?: { id: string } }[];
  console.log('demo_dept_head id:', dh.id);
  console.log('demo_dept_head raw role assignments:', JSON.stringify(dhRoles));
}
main().catch((e) => { console.error(e); process.exit(1); });
