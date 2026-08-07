/**
 * Live QA for the development-only multi-role test tenant.
 *
 * Usage:
 *   QA_BASE_URL=https://test.example.com node scripts/qa-live-role-workflow.mjs
 *
 * The script refuses to run when /api/dev/users is unavailable. It creates one
 * temporary request, exercises two competing quotations and the full seven-step
 * workflow, logs in every advertised test account, then soft-deletes the request.
 */
const base = (process.env.QA_BASE_URL || 'https://test.138.249.7.204.sslip.io').replace(/\/$/, '');
const pin = process.env.QA_PIN || '1234';

async function call(path, { token, method = 'GET', body, allow = [] } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !allow.includes(response.status)) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${payload.error || ''}`.trim());
  }
  return { status: response.status, payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(`QA assertion failed: ${message}`);
}

const devUsers = (await call('/api/dev/users')).payload.users || [];
assert(devUsers.length >= 18, `expected at least 18 test accounts, got ${devUsers.length}`);

const sessions = new Map();
const accountAudit = [];
for (const advertised of devUsers) {
  const auth = (await call('/api/auth/dev', { method: 'POST', body: { telegramId: advertised.username } })).payload;
  assert(auth.token, `${advertised.username} did not receive a token`);
  const me = (await call('/api/me', { token: auth.token })).payload;
  sessions.set(advertised.username, { token: auth.token, user: me.user, permissions: me.permissions || [] });
  accountAudit.push({
    username: advertised.username,
    roles: me.user?.roleCodes || [],
    permissionCount: (me.permissions || []).length,
  });
}

for (const required of ['sklad_01', 'nach_sklad_01', 'snab_01', 'nach_snab_01', 'zamdir_01', 'gendir_01', 'founder_01']) {
  assert(sessions.has(required), `missing required workflow account ${required}`);
}
const tokenOf = (username) => sessions.get(username).token;
const userOf = (username) => sessions.get(username).user;
const config = (await call('/api/config', { token: tokenOf('founder_01') })).payload;
assert((config.stages || []).length === 7, `expected 7 configured workflow stages, got ${(config.stages || []).length}`);

let requestId = '';
const stageAudit = [];
try {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const title = `QA ROLE MATRIX ${stamp}`;
  const created = (await call('/api/requests', {
    token: tokenOf('sklad_01'),
    method: 'POST',
    body: {
      requestType: 'material_request',
      title,
      description: 'Temporary automated role/workflow verification',
      priority: 'normal',
      items: [
        { name: 'QA Bearing 6205', quantity: 4, unit: 'шт', unitPrice: 1000 },
        { name: 'QA Industrial oil', quantity: 10, unit: 'л', unitPrice: 500 },
      ],
    },
  })).payload;
  requestId = created.id;
  assert(requestId, 'request creation did not return an id');

  async function detail(username) {
    const result = await call(`/api/requests/${requestId}`, { token: tokenOf(username), allow: [403, 404] });
    return result.status === 200 ? result.payload : null;
  }
  async function snapshot(label, expectedUser, expectedAction, auditEveryAccount = false) {
    const visible = [];
    const actors = [];
    const usernames = auditEveryAccount ? devUsers.map((user) => user.username) : [...new Set([expectedUser, 'admin_01', 'founder_01'])];
    const rows = new Map();
    for (const username of usernames) {
      const row = await detail(username);
      rows.set(username, row);
      if (!row) continue;
      visible.push(username);
      if ((row.actions || []).length) actors.push({ username, actions: row.actions.map((a) => a.action) });
    }
    const expected = actors.find((entry) => entry.username === expectedUser);
    assert(expected?.actions.includes(expectedAction), `${label}: ${expectedUser} is missing ${expectedAction}`);
    assert(!actors.some((entry) => entry.username === 'admin_01'), `${label}: admin_01 unexpectedly has business actions`);
    const ownerView = rows.get('founder_01') || await detail('founder_01');
    stageAudit.push({ label, status: ownerView?.status, visibleAccounts: auditEveryAccount ? visible.length : null, actors });
    return ownerView;
  }
  async function action(username, actionName, extra = {}) {
    return (await call(`/api/requests/${requestId}/action`, {
      token: tokenOf(username),
      method: 'POST',
      body: { action: actionName, ...extra },
    })).payload;
  }

  await snapshot('1 warehouse approval', 'nach_sklad_01', 'assign_procurement', true);
  await action('nach_sklad_01', 'assign_procurement', { pin, assigneeId: userOf('snab_01').id });

  let procurement = await snapshot('2 first quotation', 'snab_01', 'add_quotation');
  await action('snab_01', 'add_quotation', {
    supplierName: 'QA Supplier Alpha',
    paymentType: 'Перечисление',
    quoteItems: procurement.items.map((item, index) => ({
      itemId: item.id,
      unitPrice: index === 0 ? 1200 : 620,
      supplierName: 'QA Supplier Alpha',
      paymentType: 'Перечисление',
      ndsIncluded: true,
    })),
  });

  await snapshot('3 request competing quotation', 'nach_snab_01', 'return_research');
  await action('nach_snab_01', 'return_research', { comment: 'QA: request a second competitive offer' });

  procurement = await snapshot('2 second quotation', 'snab_01', 'add_quotation');
  await action('snab_01', 'add_quotation', {
    supplierName: 'QA Supplier Beta',
    paymentType: 'Наличные',
    quoteItems: procurement.items.map((item, index) => ({
      itemId: item.id,
      unitPrice: index === 0 ? 1100 : 580,
      supplierName: 'QA Supplier Beta',
      paymentType: 'Наличные',
      ndsIncluded: false,
    })),
  });

  const priceReview = await snapshot('3 choose quotation', 'nach_snab_01', 'select_supplier');
  assert(priceReview.quotations.length === 2, `expected 2 quotations, got ${priceReview.quotations.length}`);
  const beta = priceReview.quotations.find((quote) => quote.supplierName === 'QA Supplier Beta');
  assert(beta, 'second quotation is missing');
  await action('nach_snab_01', 'select_supplier', { quotationId: beta.id });
  await action('nach_snab_01', 'approve_price');

  await snapshot('4 deputy director', 'zamdir_01', 'approve');
  await action('zamdir_01', 'approve', { pin });
  await snapshot('5 director', 'gendir_01', 'approve');
  await action('gendir_01', 'approve', { pin });
  await snapshot('6 owner', 'founder_01', 'approve');
  await action('founder_01', 'approve', { pin });
  await snapshot('7 delivery', 'snab_01', 'mark_arrived');
  await action('snab_01', 'mark_arrived');

  const final = await detail('founder_01');
  assert(final.status === 'approved', `expected final approved status, got ${final.status}`);
  assert(final.currentStepId == null, 'final request still has a current workflow step');
  assert(final.quotations.length === 2, 'final request lost quotations');
  assert(final.quotations.filter((quote) => quote.selected).length === 1, 'exactly one quotation must be selected');
  assert((final.workflowTimeline || []).filter((step) => step.stepId !== 'created').length === 7, 'timeline does not contain exactly seven configured steps');

  console.log(JSON.stringify({
    ok: true,
    base,
    requestId,
    accountsLoggedIn: accountAudit.length,
    accounts: accountAudit,
    stages: stageAudit,
    final: {
      status: final.status,
      workflowSteps: final.workflowTimeline.length - 1,
      quotations: final.quotations.map((quote) => ({ supplier: quote.supplierName, amount: quote.amount, selected: quote.selected })),
    },
  }, null, 2));
} finally {
  if (requestId && sessions.has('founder_01')) {
    const cleanup = await call(`/api/admin/requests/${requestId}`, {
      token: tokenOf('founder_01'),
      method: 'DELETE',
      allow: [403, 404, 409, 429],
    });
    if (cleanup.status !== 200) console.error(`Cleanup warning: HTTP ${cleanup.status}`);
  }
}
