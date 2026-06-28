/** Company structure: holding → factories → departments / warehouses. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton } from './ui';

interface Dept {
  id: string;
  name: string;
  status: string;
  userCount: number;
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

type Kind = 'department' | 'warehouse';
interface SheetState {
  kind: Kind;
  mode: 'add' | 'rename';
  id?: string;
  name: string;
  factoryId: string;
}

export function Structure() {
  const [data, setData] = useState<Structure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [saving, setSaving] = useState(false);

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
      if (kind === 'department') await api.admin.deleteDepartment(id);
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
      if (sheet.mode === 'add' && sheet.kind === 'department') await api.admin.createDepartment(sheet.name.trim(), factoryId);
      else if (sheet.mode === 'add') await api.admin.createWarehouse(sheet.name.trim(), factoryId);
      else if (sheet.kind === 'department') await api.admin.renameDepartment(sheet.id!, sheet.name.trim());
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

  const factories = data.factories;
  const deptRow = (d: Dept) => (
    <Row key={d.id} onRename={() => setSheet({ kind: 'department', mode: 'rename', id: d.id, name: d.name, factoryId: '' })} onDelete={() => remove('department', d.id, d.name)}>
      <span className="text-sm text-fg">{d.name}</span>
      <Pill tone="muted">{d.userCount} чел.</Pill>
    </Row>
  );
  const whRow = (w: Wh) => (
    <Row key={w.id} onRename={() => setSheet({ kind: 'warehouse', mode: 'rename', id: w.id, name: w.name, factoryId: '' })} onDelete={() => remove('warehouse', w.id, w.name)}>
      <span className="text-sm text-fg">{w.name}</span>
    </Row>
  );

  return (
    <div className="space-y-5">
      {error && <Err>{error}</Err>}
      <div className="flex gap-2.5">
        <PrimaryBtn className="flex-1" onClick={() => setSheet({ kind: 'department', mode: 'add', name: '', factoryId: '' })}>
          + Отдел
        </PrimaryBtn>
        <GhostBtn className="flex-1" onClick={() => setSheet({ kind: 'warehouse', mode: 'add', name: '', factoryId: '' })}>
          + Склад
        </GhostBtn>
      </div>

      {factories.map((f) => (
        <div key={f.id} className="rounded-2xl border border-line bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-sm font-bold text-fg">🏭 {f.name}</span>
            <Pill tone="system">{f.departments.length} отд.</Pill>
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
        open={!!sheet}
        title={sheet ? `${sheet.mode === 'add' ? 'Новый' : 'Переименовать'} ${sheet.kind === 'department' ? 'отдел' : 'склад'}` : ''}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <div>
            <Label>Название</Label>
            <Field
              autoFocus
              value={sheet.name}
              onChange={(e) => setSheet({ ...sheet, name: e.target.value })}
              placeholder={sheet.kind === 'department' ? 'напр. Снабжение' : 'напр. Главный склад'}
            />
            {sheet.mode === 'add' && (
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
