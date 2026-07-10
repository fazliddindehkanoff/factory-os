const TOKEN_KEY = 'factoryos.token';
const TEST_USER_KEY = 'factoryos.testUser';

// Test mode (docs/TEST_MODE.md): a window logged in via `?user=<test login>` keeps
// its token in sessionStorage, so several windows can hold DIFFERENT users at the
// same time. localStorage stays the normal single-user store (Telegram login).
export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string, opts?: { perWindow?: boolean }): void {
  if (opts?.perWindow || sessionStorage.getItem(TOKEN_KEY) != null) sessionStorage.setItem(TOKEN_KEY, t);
  else localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TEST_USER_KEY);
  localStorage.removeItem(TOKEN_KEY);
}
/** The test-user login this WINDOW is pinned to (test mode only). */
export function getTestUser(): string | null {
  return sessionStorage.getItem(TEST_USER_KEY);
}
export function setTestUser(username: string): void {
  sessionStorage.setItem(TEST_USER_KEY, username);
}

async function call(path: string, opts: RequestInit = {}, retried = false): Promise<any> {
  const token = getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), 15000);
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
    // Auto-refresh: if token expired (401) and we had a token, clear it so the app
    // shows the login screen on next render cycle.
    if (res.status === 401 && token) {
      clearToken();
      window.location.reload();
      throw new Error('Сессия истекла — войдите снова');
    }
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
  description?: string;
}

export interface CreateRequestData {
  title?: string;
  requestType?: string;
  priority?: string;
  warehouseName?: string;
  departmentId?: string;
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
  // Dev/test only — 404 in production (stealth), callers must swallow the error.
  devUsers: (): Promise<{ users: { username: string; fullName: string; roles: string[] }[]; pin: string }> =>
    call('/dev/users'),
  me: () => call('/me'),
  config: () => call('/config'),
  form: (screen: string) => call('/form/' + screen),
  dashboard: () => call('/dashboard'),
  notificationsUnreadCount: () => call('/me/notifications/unread-count'),
  notifications: (unreadOnly?: boolean) => call('/me/notifications' + (unreadOnly ? '?unread=1' : '')),
  markNotificationRead: (id: string) => call(`/me/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => call('/me/notifications/read-all', { method: 'POST' }),
  listRequests: (opts?: { limit?: number; offset?: number; search?: string; status?: string; mine?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    // P1-7: search/filter run server-side so they match across the whole holding,
    // not just the current page.
    if (opts?.search) params.set('search', opts.search);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.mine) params.set('mine', opts.mine); // №13
    const qs = params.toString();
    return call('/requests' + (qs ? '?' + qs : ''));
  },
  inbox: () => call('/requests/inbox'),
  getRequest: (id: string) => call('/requests/' + id),
  cancelRequest: (id: string, reason?: string) =>
    call(`/requests/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason ?? '' }) }),
  rejectReasons: (id: string) => call(`/requests/${id}/reject-reasons`),
  procurementAssignees: (): Promise<{ users: { id: string; fullName: string | null }[] }> => call('/procurement/assignees'),
  createRequest: (data: CreateRequestData) =>
    call('/requests', { method: 'POST', body: JSON.stringify(data) }),
  approve: (id: string, comment?: string) =>
    call(`/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ comment }) }),
  reject: (id: string, comment: string) =>
    call(`/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) }),

  // ── Edit request ──
  updateRequest: (id: string, data: Partial<{ title: string; description: string; priority: string; warehouseName: string; neededDate: string | null }>) =>
    call(`/requests/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // ── Lifecycle ──
  requestAction: (
    id: string,
    body: { action: string; pin?: string; comment?: string; amount?: number; supplierName?: string; supplierId?: string; leadTime?: string; quotationId?: string },
  ) => call(`/requests/${id}/action`, { method: 'POST', body: JSON.stringify(body) }),
  setPin: (pin: string) => call('/me/pin', { method: 'POST', body: JSON.stringify({ pin }) }),
  updateProfile: (data: { fullName?: string; phone?: string; email?: string; position?: string }) =>
    call('/me/profile', { method: 'PUT', body: JSON.stringify(data) }),

  // ── Warehouse ──
  warehouse: {
    balances: () => call('/warehouse/balances'),
    receive: (data: { materialId: string; warehouseId?: string; quantity: number; requestId?: string; reason?: string }) =>
      call('/warehouse/receive', { method: 'POST', body: JSON.stringify(data) }),
    issue: (data: { materialId: string; warehouseId?: string; quantity: number; requestId?: string; reason?: string }) =>
      call('/warehouse/issue', { method: 'POST', body: JSON.stringify(data) }),
    movements: () => call('/warehouse/movements'),
  },

  // ── Suppliers (procurement directory) ──
  suppliers: {
    list: () => call('/suppliers'),
    create: (data: { name: string; inn?: string; phone?: string; email?: string; contactPerson?: string; category?: string; note?: string }) =>
      call('/suppliers', { method: 'POST', body: JSON.stringify(data) }),
    update: (
      id: string,
      data: Partial<{ name: string; inn: string; phone: string; email: string; contactPerson: string; category: string; note: string }>,
    ) => call('/suppliers/' + id, { method: 'PATCH', body: JSON.stringify(data) }),
    archive: (id: string) => call('/suppliers/' + id, { method: 'DELETE' }),
  },

  // ── Procurement ──
  procurement: {
    queue: () => call('/procurement/queue'),
  },

  // ── Attachments ──
  attachments: {
    list: (requestId: string) => call(`/requests/${requestId}/attachments`),
    upload: (requestId: string, data: { filename: string; dataBase64: string; mime?: string }) =>
      call(`/requests/${requestId}/attachments`, { method: 'POST', body: JSON.stringify(data) }),
    download: (id: string) => call(`/attachments/${id}`),
    remove: (id: string) => call(`/attachments/${id}`, { method: 'DELETE' }),
  },

  // ── Admin / constructor API (everything is holding-scoped server-side) ──
  admin: {
    overview: () => call('/admin/overview'),

    // Structure
    structure: () => call('/admin/structure'),
    createFactory: (name: string, data?: { type?: string; address?: string }) =>
      call('/admin/factories', { method: 'POST', body: JSON.stringify({ name, ...data }) }),
    renameFactory: (id: string, name: string) =>
      call('/admin/factories/' + id, { method: 'PUT', body: JSON.stringify({ name }) }),
    deleteFactory: (id: string) => call('/admin/factories/' + id, { method: 'DELETE' }),
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

    // Audit
    audit: (opts?: { limit?: number; offset?: number }) => {
      const p = new URLSearchParams();
      if (opts?.limit) p.set('limit', String(opts.limit));
      if (opts?.offset) p.set('offset', String(opts.offset));
      const qs = p.toString();
      return call('/admin/audit' + (qs ? '?' + qs : ''));
    },

    // Settings
    settings: () => call('/admin/settings'),
    updateSettings: (data: Record<string, string>) =>
      call('/admin/settings', { method: 'PUT', body: JSON.stringify(data) }),

    // Materials
    materials: () => call('/admin/materials'),
    createMaterial: (data: { name: string; sku?: string; defaultUnit?: string }) =>
      call('/admin/materials', { method: 'POST', body: JSON.stringify(data) }),
    updateMaterial: (id: string, data: { name?: string; sku?: string; defaultUnit?: string }) =>
      call('/admin/materials/' + id, { method: 'PUT', body: JSON.stringify(data) }),
    deleteMaterial: (id: string) => call('/admin/materials/' + id, { method: 'DELETE' }),

    // Workflow
    workflows: () => call('/admin/workflows'),
    createWorkflow: (name: string) =>
      call('/admin/workflows', { method: 'POST', body: JSON.stringify({ name }) }),
    updateWorkflow: (id: string, patch: { name?: string; is_active?: boolean }) =>
      call('/admin/workflows/' + id, { method: 'PUT', body: JSON.stringify(patch) }),
    addStep: (
      wfId: string,
      data: {
        name: string;
        step_kind?: string;
        approver_role_id: string | null;
        order_index: number;
        threshold_amount: number | null;
        condition_rule?: Record<string, unknown> | null;
        on_reject?: string;
        on_reject_step_order?: number | null;
      },
    ) => call(`/admin/workflows/${wfId}/steps`, { method: 'POST', body: JSON.stringify(data) }),
    updateStep: (
      wfId: string,
      stepId: string,
      patch: Partial<{
        name: string;
        step_kind: string;
        approver_role_id: string | null;
        order_index: number;
        threshold_amount: number | null;
        condition_rule: Record<string, unknown> | null;
        on_reject: string;
        on_reject_step_order: number | null;
      }>,
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
