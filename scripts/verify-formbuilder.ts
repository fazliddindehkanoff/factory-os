/** End-to-end check of the form builder. Run while the server is up on :3100. */
const BASE = 'http://localhost:3100';

async function tok(telegramId: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/dev`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telegramId }),
  });
  return ((await r.json()) as { token: string }).token;
}
const H = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join(' ');

async function main() {
  const owner = await tok('demo_owner');

  // 1) Admin adds a custom select field "Цвет".
  const created = (await (
    await fetch(`${BASE}/api/admin/form-fields`, {
      method: 'POST',
      headers: H(owner),
      body: JSON.stringify({
        label: 'Цвет',
        type: 'select',
        step: 2,
        required: false,
        options: [
          { value: 'Белый', label: 'Белый' },
          { value: 'Синий', label: 'Синий' },
        ],
      }),
    })
  ).json()) as { id: string; key: string; label: string; options: { label: string }[] };
  console.log('1) created field key=%s label=%j (%s)', created.key, created.label, cps(created.label));
  console.log('   option labels:', created.options.map((o) => `${o.label} [${cps(o.label)}]`).join(', '));

  // 2) It shows up in the wizard schema for a requester.
  const req = await tok('demo_requester');
  const form = (await (await fetch(`${BASE}/api/form/request_create`, { headers: H(req) })).json()) as {
    fields: { key: string; label: string }[];
  };
  const found = form.fields.find((f) => f.key === created.key);
  console.log('2) field visible in /api/form: %s (total fields now %d)', !!found, form.fields.length);

  // 3) Create a request that fills the custom field.
  const made = (await (
    await fetch(`${BASE}/api/requests`, {
      method: 'POST',
      headers: H(req),
      body: JSON.stringify({
        title: 'Пряжа',
        requestType: 'material_request',
        priority: 'high',
        items: [{ name: 'Пряжа', quantity: 100, unitPrice: 0, unit: 'кг' }],
        customFields: { [created.key]: 'Синий' },
      }),
    })
  ).json()) as { id: string; requestNumber: string };
  console.log('3) created request %s', made.requestNumber);

  // 4) Read it back — custom value persisted?
  const back = (await (await fetch(`${BASE}/api/requests/${made.id}`, { headers: H(req) })).json()) as {
    customFields: Record<string, unknown> | null;
  };
  const stored = back.customFields?.[created.key];
  console.log('4) stored custom value: %j (%s)', stored, typeof stored === 'string' ? cps(stored) : '-');

  // 5) Clean up the demo field (leave the form at its default).
  const del = await fetch(`${BASE}/api/admin/form-fields/${created.id}`, { method: 'DELETE', headers: H(owner) });
  console.log('5) deleted demo field:', del.status);

  // 6) System field cannot be deleted.
  const sys = form.fields.find((f) => f.key === 'itemName');
  const adminList = (await (await fetch(`${BASE}/api/admin/form-fields`, { headers: H(owner) })).json()) as {
    id: string;
    key: string;
    system: boolean;
  }[];
  const sysRow = adminList.find((f) => f.key === 'itemName');
  const delSys = await fetch(`${BASE}/api/admin/form-fields/${sysRow!.id}`, { method: 'DELETE', headers: H(owner) });
  console.log('6) delete system field blocked: HTTP %d (expect 409), itemName seen=%s', delSys.status, !!sys);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
