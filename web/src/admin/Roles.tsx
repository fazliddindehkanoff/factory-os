/** Roles & permissions: list roles, edit a custom role's permission set by module. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Skeleton } from './ui';

interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}
interface Perm {
  code: string;
  name: string;
  module: string;
}

const MODULE_LABEL: Record<string, string> = {
  requests: 'Заявки',
  approvals: 'Согласования',
  warehouse: 'Склад',
  procurement: 'Закупки',
  suppliers: 'Поставщики',
  finance: 'Финансы',
  admin: 'Администрирование',
  audit: 'Аудит',
  reports: 'Отчёты',
};

export function Roles({ canManage }: { canManage: boolean }) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [perms, setPerms] = useState<Perm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Role | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.admin.roles(), api.admin.permissions()])
      .then(([r, p]) => {
        setRoles(r);
        setPerms(p);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  if (selected) {
    return (
      <RoleEditor
        role={selected}
        perms={perms}
        canManage={canManage}
        onBack={() => { load(); setSelected(null); }}
        onChanged={() => { load(); setSelected(null); }}
        onRefresh={load}
        setError={setError}
      />
    );
  }

  if (error && !roles) return <Err>{error}</Err>;
  if (!roles) return <Skeleton />;

  return (
    <div className="space-y-4">
      {error && <Err>{error}</Err>}
      {canManage && (
        <PrimaryBtn className="w-full" onClick={() => setCreateOpen(true)}>
          + Создать набор прав
        </PrimaryBtn>
      )}
      <div className="space-y-2.5">
        {roles.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r)}
            className="flex w-full items-center justify-between rounded-2xl border border-line bg-card p-4 text-left active:scale-[0.99]"
          >
            <div>
              <div className="text-sm font-semibold text-fg">{r.name}</div>
              <div className="font-mono text-xs text-fg3">{r.code}</div>
            </div>
            <div className="flex items-center gap-2">
              <Pill tone="muted">{r.permissions.length} прав</Pill>
              {r.isSystem ? <Pill tone="system">система</Pill> : <Pill tone="accent">custom</Pill>}
            </div>
          </button>
        ))}
        {roles.length === 0 && <Empty>Ролей нет.</Empty>}
      </div>

      <CreateRoleSheet open={createOpen} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); load(); }} setError={setError} />
    </div>
  );
}

function RoleEditor({
  role,
  perms,
  canManage,
  onBack,
  onChanged,
  onRefresh,
  setError,
}: {
  role: Role;
  perms: Perm[];
  canManage: boolean;
  onBack: () => void;
  onChanged: () => void;
  onRefresh: () => void;
  setError: (s: string) => void;
}) {
  const [codes, setCodes] = useState<Set<string>>(new Set(role.permissions));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(role.name);
  const readOnly = !canManage;

  const groups = useMemo(() => {
    const m = new Map<string, Perm[]>();
    for (const p of perms) {
      const arr = m.get(p.module) ?? [];
      arr.push(p);
      m.set(p.module, arr);
    }
    return [...m.entries()];
  }, [perms]);

  const toggle = (code: string) => {
    if (readOnly) return;
    setSaved(false);
    setCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.admin.setRolePermissions(role.id, [...codes]);
      setSaved(true);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const rename = async () => {
    try {
      await api.admin.renameRole(role.id, name.trim());
      setRenameOpen(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog(`Удалить набор прав «${role.name}»?`))) return;
    try {
      await api.admin.deleteRole(role.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <button onClick={onBack} className="mb-3 text-sm font-medium text-fg2 hover:text-fg">
        ← Назад
      </button>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-base font-bold text-fg">{role.name}</div>
          <div className="font-mono text-xs text-fg3">{role.code}</div>
        </div>
        {role.isSystem ? (
          <Pill tone="system">системная</Pill>
        ) : !canManage ? (
          <Pill tone="muted">только просмотр</Pill>
        ) : (
          <div className="flex gap-1.5">
            <MiniBtn onClick={() => setRenameOpen(true)}>✎</MiniBtn>
            <MiniBtn className="bg-danger/15 text-danger" onClick={remove}>
              Удалить
            </MiniBtn>
          </div>
        )}
      </div>

      {!canManage && (
        <div className="mb-4 rounded-xl bg-white/5 px-3 py-2.5 text-xs text-fg2">
          Создавать и менять роли может только super admin.
        </div>
      )}

      <div className="space-y-4">
        {groups.map(([module, list]) => (
          <div key={module} className="rounded-2xl border border-line bg-card p-4">
            <Label>{MODULE_LABEL[module] ?? module}</Label>
            <div className="space-y-1">
              {list.map((p) => {
                const on = codes.has(p.code);
                return (
                  <button
                    key={p.code}
                    onClick={() => toggle(p.code)}
                    disabled={readOnly}
                    className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left disabled:opacity-70"
                  >
                    <span className="text-sm text-fg">{p.name}</span>
                    <span
                      className={`flex h-5 w-5 flex-none items-center justify-center rounded-md border text-xs ${
                        on ? 'border-accent bg-accent text-white' : 'border-edge bg-card2 text-transparent'
                      }`}
                    >
                      ✓
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {!readOnly && (
        <PrimaryBtn
          className={`mt-5 w-full transition-colors ${saved ? 'bg-green-600' : ''}`}
          disabled={saving}
          onClick={save}
        >
          {saving ? '…' : saved ? 'Сохранено ✓' : 'Сохранить'}
        </PrimaryBtn>
      )}

      <BottomSheet open={renameOpen} title="Переименовать набор прав" onClose={() => setRenameOpen(false)}>
        <Label>Название</Label>
        <Field value={name} onChange={(e) => setName(e.target.value)} />
        <div className="mt-5 flex gap-2.5">
          <GhostBtn className="flex-1" onClick={() => setRenameOpen(false)}>
            Отмена
          </GhostBtn>
          <PrimaryBtn className="flex-1" disabled={!name.trim()} onClick={rename}>
            Сохранить
          </PrimaryBtn>
        </div>
      </BottomSheet>
    </div>
  );
}

function CreateRoleSheet({
  open,
  onClose,
  onDone,
  setError,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  setError: (s: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!code.trim() || !name.trim()) return;
    setSaving(true);
    try {
      await api.admin.createRole(code.trim(), name.trim());
      setCode('');
      setName('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} title="Новый набор прав" onClose={onClose}>
      <Label>Код (латиницей)</Label>
      <Field value={code} onChange={(e) => setCode(e.target.value)} placeholder="напр. buyer" />
      <div className="mt-4">
        <Label>Название</Label>
        <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Закупщик" />
      </div>
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>
          Отмена
        </GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !code.trim() || !name.trim()} onClick={submit}>
          {saving ? '…' : 'Создать'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}
