const TOKEN_KEY = 'factoryos.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function call(path: string, opts: RequestInit = {}, retried = false): Promise<any> {
  const token = getToken();
  const controller = new AbortController();
  // 25s: the DB (Neon free tier) can take 10–15s to wake from idle on the first hit.
  const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), 25000);
  try {
    const res = await fetch('/api' + path, {
      ...opts,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  } catch (e) {
    const aborted = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const method = (opts.method ?? 'GET').toUpperCase();
    // Retry once on a GET timeout — the first hit usually wakes the DB; the retry then succeeds.
    if (aborted && !retried && method === 'GET') {
      clearTimeout(timeout);
      return call(path, opts, true);
    }
    if (aborted) throw new Error('Сервер не ответил вовремя — возможно, база просыпается. Повторите через пару секунд.');
    if (e instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export interface RequestItemInput {
  name: string;
  quantity: number;
  unitPrice: number;
  unit?: string;
}

export interface CreateRequestData {
  title?: string;
  requestType?: string;
  priority?: string;
  warehouseName?: string;
  description?: string;
  neededDate?: string | null;
  customFields?: Record<string, unknown>;
  items: RequestItemInput[];
}

export const api = {
  loginTelegram: (initData: string) =>
    call('/auth/telegram', { method: 'POST', body: JSON.stringify({ initData }) }),
  loginDev: (telegramId: string) =>
    call('/auth/dev', { method: 'POST', body: JSON.stringify({ telegramId }) }),
  me: () => call('/me'),
  config: () => call('/config'),
  form: (screen: string) => call('/form/' + screen),
  dashboard: () => call('/dashboard'),
  listRequests: () => call('/requests'),
  inbox: () => call('/requests/inbox'),
  getRequest: (id: string) => call('/requests/' + id),
  createRequest: (data: CreateRequestData) =>
    call('/requests', { method: 'POST', body: JSON.stringify(data) }),
  approve: (id: string, comment?: string) =>
    call(`/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ comment }) }),
  reject: (id: string, comment: string) =>
    call(`/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) }),

  // ── Lifecycle ──
  requestAction: (
    id: string,
    body: { action: string; pin?: string; comment?: string; amount?: number; supplierName?: string; leadTime?: string; quotationId?: string },
  ) => call(`/requests/${id}/action`, { method: 'POST', body: JSON.stringify(body) }),
  setPin: (pin: string) => call('/me/pin', { method: 'POST', body: JSON.stringify({ pin }) }),

  // ── Admin / constructor API (everything is holding-scoped server-side) ──
  admin: {
    overview: () => call('/admin/overview'),

    // Structure
    structure: () => call('/admin/structure'),
    createDepartment: (name: string, factoryId: string | null) =>
      call('/admin/departments', { method: 'POST', body: JSON.stringify({ name, factory_id: factoryId }) }),
    renameDepartment: (id: string, name: string) =>
      call('/admin/departments/' + id, { method: 'PUT', body: JSON.stringify({ name }) }),
    deleteDepartment: (id: string) => call('/admin/departments/' + id, { method: 'DELETE' }),
    departmentUsers: (id: string) => call(`/admin/departments/${id}/users`),
    createWarehouse: (name: string, factoryId: string | null) =>
      call('/admin/warehouses', { method: 'POST', body: JSON.stringify({ name, factory_id: factoryId }) }),
    renameWarehouse: (id: string, name: string) =>
      call('/admin/warehouses/' + id, { method: 'PUT', body: JSON.stringify({ name }) }),
    deleteWarehouse: (id: string) => call('/admin/warehouses/' + id, { method: 'DELETE' }),

    // People
    users: () => call('/admin/users'),
    invite: (telegramId: string, name: string) =>
      call('/admin/users/invite', { method: 'POST', body: JSON.stringify({ telegram_id: telegramId, name }) }),
    deleteUser: (id: string) => call('/admin/users/' + id, { method: 'DELETE' }),
    userRoles: (id: string) => call(`/admin/users/${id}/roles`),
    assignRole: (userId: string, roleId: string, scope?: { factoryId?: string; departmentId?: string }) =>
      call(`/admin/users/${userId}/roles`, { method: 'POST', body: JSON.stringify({ roleId, ...(scope ?? {}) }) }),
    revokeRole: (userId: string, roleId: string) =>
      call(`/admin/users/${userId}/roles/${roleId}`, { method: 'DELETE' }),
    revokeAssignment: (userId: string, assignmentId: string) =>
      call(`/admin/users/${userId}/assignments/${assignmentId}`, { method: 'DELETE' }),

    // Roles & permissions
    permissions: () => call('/admin/permissions'),
    roles: () => call('/admin/roles'),
    createRole: (code: string, name: string) =>
      call('/admin/roles', { method: 'POST', body: JSON.stringify({ code, name }) }),
    renameRole: (id: string, name: string) =>
      call('/admin/roles/' + id, { method: 'PUT', body: JSON.stringify({ name }) }),
    deleteRole: (id: string) => call('/admin/roles/' + id, { method: 'DELETE' }),
    setRolePermissions: (id: string, codes: string[]) =>
      call(`/admin/roles/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ codes }) }),

    // Workflow
    workflows: () => call('/admin/workflows'),
    createWorkflow: (name: string) =>
      call('/admin/workflows', { method: 'POST', body: JSON.stringify({ name }) }),
    updateWorkflow: (id: string, patch: { name?: string; is_active?: boolean }) =>
      call('/admin/workflows/' + id, { method: 'PUT', body: JSON.stringify(patch) }),
    workflowSteps: (id: string) => call(`/admin/workflows/${id}/steps`),
    addStep: (
      wfId: string,
      data: { name: string; approver_role_id: string | null; order_index: number; threshold_amount: number | null },
    ) => call(`/admin/workflows/${wfId}/steps`, { method: 'POST', body: JSON.stringify(data) }),
    updateStep: (
      wfId: string,
      stepId: string,
      patch: Partial<{ name: string; approver_role_id: string | null; order_index: number; threshold_amount: number | null }>,
    ) => call(`/admin/workflows/${wfId}/steps/${stepId}`, { method: 'PUT', body: JSON.stringify(patch) }),
    deleteStep: (wfId: string, stepId: string) =>
      call(`/admin/workflows/${wfId}/steps/${stepId}`, { method: 'DELETE' }),
    reorderSteps: (wfId: string, order: { id: string; order_index: number }[]) =>
      call(`/admin/workflows/${wfId}/steps/reorder`, { method: 'PUT', body: JSON.stringify(order) }),

    // ── Form builder (configurable create form) ──
    formFields: (screen = 'request_create') =>
      call('/admin/form-fields?screen=' + encodeURIComponent(screen)),
    createField: (data: {
      screen?: string;
      label: string;
      type: string;
      required?: boolean;
      placeholder?: string;
      step?: number;
      options?: { value: string; label: string; meta?: string }[];
    }) => call('/admin/form-fields', { method: 'POST', body: JSON.stringify(data) }),
    updateField: (id: string, patch: Record<string, unknown>) =>
      call('/admin/form-fields/' + id, { method: 'PUT', body: JSON.stringify(patch) }),
    deleteField: (id: string) => call('/admin/form-fields/' + id, { method: 'DELETE' }),
    reorderFields: (order: { id: string; orderIndex?: number; step?: number }[]) =>
      call('/admin/form-fields/reorder', { method: 'PUT', body: JSON.stringify({ order }) }),
  },
};
