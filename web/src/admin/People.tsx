/** People: list users, invite by Telegram id, view a user's roles, assign / revoke. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { Avatar, BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton } from './ui';

interface UserRoleRef {
  assignmentId: string;
  roleId: string;
  roleCode?: string;
  factoryId: string | null;
  departmentId: string | null;
}
interface UserRow {
  id: string;
  fullName: string;
  telegramId: string | null;
  status: string;
  roles: UserRoleRef[];
}
interface RoleOpt {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
}
interface DeptOpt {
  id: string;
  name: string;
}

export function People() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [roles, setRoles] = useState<RoleOpt[]>([]);
  const [depts, setDepts] = useState<DeptOpt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterDept, setFilterDept] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);

  const load = useCallback(() => {
    // The user list is the core data; roles & structure only feed the role selector
    // and the department filter, and may 403 for a users.manage-only admin — load them
    // best-effort so a missing catalog never blanks the whole page.
    api.admin
      .users()
      .then(setUsers)
      .catch((e) => setError((e as Error).message));
    api.admin.roles().then(setRoles).catch(() => setRoles([]));
    api.admin
      .structure()
      .then((s: { factories: { departments: DeptOpt[] }[]; unassigned: { departments: DeptOpt[] } }) =>
        setDepts([...s.factories.flatMap((f) => f.departments), ...s.unassigned.departments]),
      )
      .catch(() => setDepts([]));
  }, []);
  useEffect(load, [load]);

  const deptName = useMemo(() => new Map(depts.map((d) => [d.id, d.name])), [depts]);

  if (selected) {
    return (
      <UserDetail
        user={selected}
        roles={roles}
        depts={depts}
        onBack={() => setSelected(null)}
        onChanged={() => {
          load();
          setSelected(null);
        }}
        setError={setError}
      />
    );
  }

  if (error && !users) return <Err>{error}</Err>;
  if (!users) return <Skeleton />;

  const visible = users.filter((u) => u.status !== 'archived' && u.status !== 'disabled');
  const shown = filterDept
    ? visible.filter((u) => u.roles.some((r) => r.departmentId === filterDept))
    : visible;

  return (
    <div className="space-y-4">
      {error && <Err>{error}</Err>}
      <div className="flex items-center gap-2.5">
        <Select className="flex-1" value={filterDept} onChange={(e) => setFilterDept((e.target as HTMLSelectElement).value)}>
          <option value="">Все отделы</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <PrimaryBtn onClick={() => setInviteOpen(true)}>+ Добавить</PrimaryBtn>
      </div>

      {shown.length === 0 && <Empty>Никого не найдено.</Empty>}
      <div className="space-y-2.5">
        {shown.map((u) => (
          <button
            key={u.id}
            onClick={() => setSelected(u)}
            className="flex w-full items-center gap-3 rounded-2xl border border-line bg-card p-3 text-left active:scale-[0.99]"
          >
            <Avatar name={u.fullName} tone={u.status === 'active' ? 'accent' : 'muted'} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-fg">{u.fullName}</span>
                {u.status !== 'active' && <Pill tone="danger">{u.status}</Pill>}
              </div>
              <div className="truncate font-mono text-xs text-fg3">{u.telegramId ?? '—'}</div>
              {u.roles.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {u.roles.map((r) => (
                    <Pill key={r.assignmentId} tone="system">
                      {r.roleCode ?? r.roleId.slice(0, 6)}
                      {r.departmentId ? ` · ${deptName.get(r.departmentId) ?? '…'}` : ''}
                    </Pill>
                  ))}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>

      <InviteSheet
        open={inviteOpen}
        roles={roles}
        depts={depts}
        onClose={() => setInviteOpen(false)}
        onDone={() => {
          setInviteOpen(false);
          load();
        }}
        setError={setError}
      />
    </div>
  );
}

function InviteSheet({
  open,
  roles,
  depts,
  onClose,
  onDone,
  setError,
}: {
  open: boolean;
  roles: RoleOpt[];
  depts: DeptOpt[];
  onClose: () => void;
  onDone: () => void;
  setError: (s: string) => void;
}) {
  const [tgId, setTgId] = useState('');
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [deptId, setDeptId] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!tgId.trim() || !name.trim()) return;
    setSaving(true);
    try {
      const created = await api.admin.invite(tgId.trim(), name.trim());
      if (roleId) await api.admin.assignRole(created.id, roleId, deptId ? { departmentId: deptId } : undefined);
      setTgId('');
      setName('');
      setRoleId('');
      setDeptId('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} title="Добавить человека" onClose={onClose}>
      <Label>Telegram ID</Label>
      <Field value={tgId} onChange={(e) => setTgId(e.target.value)} placeholder="напр. 8236045489" inputMode="numeric" />
      <div className="mt-4">
        <Label>Имя</Label>
        <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя Фамилия" />
      </div>
      <div className="mt-4">
        <Label>Права (необязательно)</Label>
        <Select value={roleId} onChange={(e) => setRoleId((e.target as HTMLSelectElement).value)}>
          <option value="">Без прав</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      {roleId && depts.length > 0 && (
        <div className="mt-4">
          <Label>Отдел (область прав)</Label>
          <Select value={deptId} onChange={(e) => setDeptId((e.target as HTMLSelectElement).value)}>
            <option value="">Весь холдинг</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>
          Отмена
        </GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !tgId.trim() || !name.trim()} onClick={submit}>
          {saving ? '…' : 'Добавить'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}

interface DetailRole {
  assignmentId: string;
  roleId: string;
  roleCode?: string;
  roleName?: string;
  departmentId: string | null;
  permissions: string[];
}

function UserDetail({
  user,
  roles,
  depts,
  onBack,
  onChanged,
  setError,
}: {
  user: UserRow;
  roles: RoleOpt[];
  depts: DeptOpt[];
  onBack: () => void;
  onChanged: () => void;
  setError: (s: string) => void;
}) {
  const [list, setList] = useState<DetailRole[] | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [deptId, setDeptId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.admin
      .userRoles(user.id)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [user.id, setError]);
  useEffect(load, [load]);

  const revoke = async (assignmentId: string) => {
    if (!(await confirmDialog('Снять права?'))) return;
    try {
      await api.admin.revokeAssignment(user.id, assignmentId);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeUser = async () => {
    if (!(await confirmDialog(`Удалить ${user.fullName}? Если у пользователя есть история (заявки, согласования) — он будет архивирован.`))) return;
    try {
      await api.admin.deleteUser(user.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const assign = async () => {
    if (!roleId) return;
    setBusy(true);
    try {
      await api.admin.assignRole(user.id, roleId, deptId ? { departmentId: deptId } : undefined);
      setAssignOpen(false);
      setRoleId('');
      setDeptId('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button onClick={onBack} className="mb-3 text-sm font-medium text-fg2 hover:text-fg">
        ← Назад
      </button>
      <div className="mb-4 flex items-center gap-3">
        <Avatar name={user.fullName} />
        <div>
          <div className="text-base font-bold text-fg">{user.fullName}</div>
          <div className="font-mono text-xs text-fg3">{user.telegramId ?? '—'}</div>
        </div>
      </div>

      <div className="mb-2 flex items-center justify-between">
        <Label>Права</Label>
        <MiniBtn className="bg-accent/15 text-accent" onClick={() => setAssignOpen(true)}>
          + Права
        </MiniBtn>
      </div>
      {!list && <Skeleton />}
      {list && list.length === 0 && <Empty>Прав нет.</Empty>}
      <div className="space-y-2.5">
        {list?.map((r) => (
          <div key={r.assignmentId} className="rounded-2xl border border-line bg-card p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-fg">{r.roleName ?? r.roleCode}</span>
              <MiniBtn className="bg-danger/15 text-danger" onClick={() => revoke(r.assignmentId)}>
                Снять
              </MiniBtn>
            </div>
            {r.permissions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {r.permissions.map((p) => (
                  <span key={p} className="rounded-md bg-card2 px-1.5 py-0.5 font-mono text-[10px] text-fg3">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <button onClick={removeUser} className="mt-6 w-full rounded-xl bg-danger/15 py-3 text-sm font-semibold text-danger active:scale-95">
        Удалить пользователя
      </button>

      <BottomSheet open={assignOpen} title="Назначить права" onClose={() => setAssignOpen(false)}>
        <Label>Права</Label>
        <Select value={roleId} onChange={(e) => setRoleId((e.target as HTMLSelectElement).value)}>
          <option value="">Выберите права</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        {depts.length > 0 && (
          <div className="mt-4">
            <Label>Отдел (область)</Label>
            <Select value={deptId} onChange={(e) => setDeptId((e.target as HTMLSelectElement).value)}>
              <option value="">Весь холдинг</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="mt-5 flex gap-2.5">
          <GhostBtn className="flex-1" onClick={() => setAssignOpen(false)}>
            Отмена
          </GhostBtn>
          <PrimaryBtn className="flex-1" disabled={busy || !roleId} onClick={assign}>
            {busy ? '…' : 'Назначить'}
          </PrimaryBtn>
        </div>
      </BottomSheet>
    </div>
  );
}
