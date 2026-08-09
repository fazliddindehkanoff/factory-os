/** Company structure: holding → factories → departments / warehouses. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { Avatar, BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton } from './ui';

interface Dept {
  id: string;
  name: string;
  nameUz: string | null;
  nameTr: string | null;
  status: string;
  userCount: number;
  warehouseId: string | null;
}
interface Wh {
  id: string;
  name: string;
  status: string;
}
interface Factory {
  id: string;
  name: string;
  status: string;
  departments: Dept[];
  warehouses: Wh[];
}
interface Structure {
  holding: { id: string; name: string } | null;
  factories: Factory[];
  unassigned: { departments: Dept[]; warehouses: Wh[] };
}

type Kind = 'department' | 'warehouse' | 'factory';
interface SheetState {
  kind: Kind;
  mode: 'add' | 'rename';
  id?: string;
  name: string;
  nameUz: string;
  nameTr: string;
  factoryId: string;
  warehouseId: string;
}

interface DeptUser {
  id: string;
  fullName: string;
  telegramId: string | null;
  status: string;
  roles: string[];
}

export function Structure() {
  const [data, setData] = useState<Structure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deptUsersId, setDeptUsersId] = useState<string | null>(null);
  const [deptUsersName, setDeptUsersName] = useState('');
  const [deptUsers, setDeptUsers] = useState<DeptUser[] | null>(null);

  const load = useCallback(() => {
    api.admin
      .structure()
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const remove = async (kind: Kind, id: string, name: string) => {
    if (!(await confirmDialog(`Удалить «${name}»?`))) return;
    try {
      if (kind === 'factory') await api.admin.deleteFactory(id);
      else if (kind === 'department') await api.admin.deleteDepartment(id);
      else await api.admin.deleteWarehouse(id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async () => {
    if (!sheet || !sheet.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const factoryId = sheet.factoryId || null;
      if (sheet.kind === 'factory' && sheet.mode === 'add') await api.admin.createFactory(sheet.name.trim());
      else if (sheet.kind === 'factory') await api.admin.renameFactory(sheet.id!, sheet.name.trim());
      else if (sheet.mode === 'add' && sheet.kind === 'department')
        await api.admin.createDepartment(sheet.name.trim(), factoryId, sheet.nameUz.trim(), sheet.nameTr.trim(), sheet.warehouseId || null);
      else if (sheet.mode === 'add') await api.admin.createWarehouse(sheet.name.trim(), factoryId);
      else if (sheet.kind === 'department')
        await api.admin.renameDepartment(sheet.id!, sheet.name.trim(), sheet.nameUz.trim(), sheet.nameTr.trim(), sheet.warehouseId || null);
      else await api.admin.renameWarehouse(sheet.id!, sheet.name.trim());
      setSheet(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) return <Err>{error}</Err>;
  if (!data) return <Skeleton />;

  const showDeptUsers = async (deptId: string, deptName: string) => {
    setDeptUsersId(deptId);
    setDeptUsersName(deptName);
    setDeptUsers(null);
    try {
      const users = await api.admin.departmentUsers(deptId);
      setDeptUsers(users);
    } catch (e) {
      setError((e as Error).message);
      setDeptUsersId(null);
    }
  };

  const factories = data.factories;
  const allWarehouses = [...factories.flatMap((factory) => factory.warehouses), ...data.unassigned.warehouses];
  const warehouseName = new Map(allWarehouses.map((warehouse) => [warehouse.id, warehouse.name]));
  const deptRow = (d: Dept) => (
    <Row key={d.id} onRename={() => setSheet({ kind: 'department', mode: 'rename', id: d.id, name: d.name, nameUz: d.nameUz ?? '', nameTr: d.nameTr ?? '', factoryId: '', warehouseId: d.warehouseId ?? '' })} onDelete={() => remove('department', d.id, d.name)}>
      <button onClick={() => showDeptUsers(d.id, d.name)} className="flex items-center gap-2 text-left">
        <span className="text-sm text-fg">{d.name}</span>
        <Pill tone="muted">{d.userCount} чел.</Pill>
        {d.warehouseId && <Pill tone="system">{warehouseName.get(d.warehouseId) ?? 'Склад'}</Pill>}
      </button>
    </Row>
  );
  const whRow = (w: Wh) => (
    <Row key={w.id} onRename={() => setSheet({ kind: 'warehouse', mode: 'rename', id: w.id, name: w.name, nameUz: '', nameTr: '', factoryId: '', warehouseId: '' })} onDelete={() => remove('warehouse', w.id, w.name)}>
      <span className="text-sm text-fg">{w.name}</span>
    </Row>
  );

  return (
    <div className="space-y-5">
      {error && <Err>{error}</Err>}
      <div className="flex gap-2.5">
        <PrimaryBtn className="flex-1" onClick={() => setSheet({ kind: 'factory', mode: 'add', name: '', nameUz: '', nameTr: '', factoryId: '', warehouseId: '' })}>
          + Завод
        </PrimaryBtn>
        <GhostBtn className="flex-1" onClick={() => setSheet({ kind: 'department', mode: 'add', name: '', nameUz: '', nameTr: '', factoryId: '', warehouseId: '' })}>
          + Отдел
        </GhostBtn>
        <GhostBtn className="flex-1" onClick={() => setSheet({ kind: 'warehouse', mode: 'add', name: '', nameUz: '', nameTr: '', factoryId: '', warehouseId: '' })}>
          + Склад
        </GhostBtn>
      </div>

      {factories.map((f) => (
        <div key={f.id} className="rounded-2xl border border-line bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-fg">🏭 {f.name}</span>
              <Pill tone="system">{f.departments.length} отд.</Pill>
            </div>
            <div className="flex gap-1.5">
              <MiniBtn onClick={() => setSheet({ kind: 'factory', mode: 'rename', id: f.id, name: f.name, nameUz: '', nameTr: '', factoryId: '', warehouseId: '' })}>✎</MiniBtn>
              <MiniBtn className="bg-danger/15 text-danger" onClick={() => remove('factory', f.id, f.name)}>✕</MiniBtn>
            </div>
          </div>
          <Label>Отделы</Label>
          {f.departments.length === 0 ? <Hint>Нет отделов</Hint> : <div className="space-y-1.5">{f.departments.map(deptRow)}</div>}
          <div className="mt-3" />
          <Label>Склады</Label>
          {f.warehouses.length === 0 ? <Hint>Нет складов</Hint> : <div className="space-y-1.5">{f.warehouses.map(whRow)}</div>}
        </div>
      ))}

      {(data.unassigned.departments.length > 0 || data.unassigned.warehouses.length > 0) && (
        <div className="rounded-2xl border border-line bg-card p-4">
          <div className="mb-3 text-sm font-bold text-fg2">Без завода (на уровне холдинга)</div>
          {data.unassigned.departments.length > 0 && (
            <>
              <Label>Отделы</Label>
              <div className="space-y-1.5">{data.unassigned.departments.map(deptRow)}</div>
              <div className="mt-3" />
            </>
          )}
          {data.unassigned.warehouses.length > 0 && (
            <>
              <Label>Склады</Label>
              <div className="space-y-1.5">{data.unassigned.warehouses.map(whRow)}</div>
            </>
          )}
        </div>
      )}

      {factories.length === 0 && <Empty>Нет заводов в этом холдинге.</Empty>}

      <BottomSheet
        open={!!deptUsersId}
        title={`Сотрудники: ${deptUsersName}`}
        onClose={() => setDeptUsersId(null)}
      >
        {!deptUsers && <Skeleton />}
        {deptUsers && deptUsers.length === 0 && <Empty>В отделе нет сотрудников.</Empty>}
        {deptUsers && deptUsers.length > 0 && (
          <div className="space-y-2">
            {deptUsers.map((u) => (
              <div key={u.id} className="flex items-center gap-3 rounded-xl bg-card2 p-3">
                <Avatar name={u.fullName} tone={u.status === 'active' ? 'accent' : 'muted'} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-fg">{u.fullName}</div>
                  <div className="truncate font-mono text-xs text-fg3">{u.telegramId ?? '—'}</div>
                  {u.roles.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <Pill key={r} tone="system">{r}</Pill>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </BottomSheet>

      <BottomSheet
        open={!!sheet}
        title={sheet ? `${sheet.mode === 'add' ? 'Новый' : 'Переименовать'} ${sheet.kind === 'factory' ? 'завод' : sheet.kind === 'department' ? 'отдел' : 'склад'}` : ''}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <div>
            <Label>{sheet.kind === 'department' ? 'Название (RU)' : 'Название'}</Label>
            <Field
              value={sheet.name}
              onChange={(e) => setSheet({ ...sheet, name: e.target.value })}
              placeholder={sheet.kind === 'factory' ? 'напр. Главный завод' : sheet.kind === 'department' ? 'напр. Снабжение' : 'напр. Главный склад'}
            />
            {sheet.kind === 'department' && (
              <>
                <div className="mt-4">
                  <Label>Название (UZ)</Label>
                  <Field value={sheet.nameUz} onChange={(e) => setSheet({ ...sheet, nameUz: e.target.value })} placeholder="напр. Ta'minot" />
                </div>
                <div className="mt-4">
                  <Label>Название (TR)</Label>
                  <Field value={sheet.nameTr} onChange={(e) => setSheet({ ...sheet, nameTr: e.target.value })} placeholder="напр. Tedarik" />
                </div>
                <div className="mt-4">
                  <Label>Склад отдела</Label>
                  <Select value={sheet.warehouseId} onChange={(e) => setSheet({ ...sheet, warehouseId: (e.target as HTMLSelectElement).value })}>
                    <option value="">Не назначен</option>
                    {allWarehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
                    ))}
                  </Select>
                </div>
              </>
            )}
            {sheet.mode === 'add' && sheet.kind !== 'factory' && (
              <div className="mt-4">
                <Label>Завод</Label>
                <Select value={sheet.factoryId} onChange={(e) => setSheet({ ...sheet, factoryId: (e.target as HTMLSelectElement).value })}>
                  <option value="">Без завода (холдинг)</option>
                  {factories.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="mt-5 flex gap-2.5">
              <GhostBtn className="flex-1" onClick={() => setSheet(null)}>
                Отмена
              </GhostBtn>
              <PrimaryBtn className="flex-1" disabled={saving || !sheet.name.trim()} onClick={submit}>
                {saving ? '…' : 'Сохранить'}
              </PrimaryBtn>
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}

function Row({ children, onRename, onDelete }: { children: ReactNode; onRename: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-card2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="flex flex-none gap-1.5">
        <MiniBtn onClick={onRename}>✎</MiniBtn>
        <MiniBtn className="bg-danger/15 text-danger" onClick={onDelete}>
          ✕
        </MiniBtn>
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-edge px-3 py-3 text-center text-xs text-fg3">{children}</div>;
}
