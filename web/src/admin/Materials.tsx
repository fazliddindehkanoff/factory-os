/** Materials catalog: list, create, edit, delete materials. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Skeleton } from './ui';

interface Material {
  id: string;
  name: string;
  sku: string | null;
  defaultUnit: string | null;
  status: string;
}

export function Materials() {
  const [items, setItems] = useState<Material[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);

  const load = useCallback(() => {
    api.admin.materials().then(setItems).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const remove = async (m: Material) => {
    if (!(await confirmDialog(`Удалить «${m.name}»?`))) return;
    try {
      await api.admin.deleteMaterial(m.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !items) return <Err>{error}</Err>;
  if (!items) return <Skeleton />;

  return (
    <div className="space-y-4">
      {error && <Err>{error}</Err>}
      <PrimaryBtn className="w-full" onClick={() => setAddOpen(true)}>
        + Добавить материал
      </PrimaryBtn>

      {items.length === 0 && <Empty>Материалов нет. Добавьте первый.</Empty>}

      <div className="space-y-2.5">
        {items.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between rounded-2xl border border-line bg-card p-4"
          >
            <button onClick={() => setEditing(m)} className="min-w-0 flex-1 text-left">
              <div className="text-sm font-semibold text-fg">{m.name}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {m.sku && <Pill tone="muted">SKU: {m.sku}</Pill>}
                {m.defaultUnit && <Pill tone="system">{m.defaultUnit}</Pill>}
              </div>
            </button>
            <MiniBtn className="bg-danger/15 text-danger" onClick={() => remove(m)}>
              Удалить
            </MiniBtn>
          </div>
        ))}
      </div>

      <AddMaterialSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onDone={() => { setAddOpen(false); load(); }}
        setError={setError}
      />

      {editing && (
        <EditMaterialSheet
          material={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); load(); }}
          setError={setError}
        />
      )}
    </div>
  );
}

function AddMaterialSheet({
  open, onClose, onDone, setError,
}: {
  open: boolean; onClose: () => void; onDone: () => void; setError: (s: string) => void;
}) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.admin.createMaterial({
        name: name.trim(),
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        ...(unit.trim() ? { defaultUnit: unit.trim() } : {}),
      });
      setName(''); setSku(''); setUnit('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} title="Новый материал" onClose={onClose}>
      <Label>Название</Label>
      <Field autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Болт М8×40" />
      <div className="mt-4">
        <Label>Артикул / SKU (необязательно)</Label>
        <Field value={sku} onChange={(e) => setSku(e.target.value)} placeholder="напр. BLT-M8-40" />
      </div>
      <div className="mt-4">
        <Label>Единица измерения</Label>
        <Field value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="напр. шт, кг, м" />
      </div>
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>Отмена</GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !name.trim()} onClick={submit}>
          {saving ? '...' : 'Добавить'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}

function EditMaterialSheet({
  material, onClose, onDone, setError,
}: {
  material: Material; onClose: () => void; onDone: () => void; setError: (s: string) => void;
}) {
  const [name, setName] = useState(material.name);
  const [sku, setSku] = useState(material.sku ?? '');
  const [unit, setUnit] = useState(material.defaultUnit ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.admin.updateMaterial(material.id, {
        name: name.trim(),
        sku: sku.trim() || undefined,
        defaultUnit: unit.trim() || undefined,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open title={`Материал: ${material.name}`} onClose={onClose}>
      <Label>Название</Label>
      <Field autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <div className="mt-4">
        <Label>Артикул / SKU</Label>
        <Field value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" />
      </div>
      <div className="mt-4">
        <Label>Единица измерения</Label>
        <Field value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="шт, кг, м" />
      </div>
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>Отмена</GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !name.trim()} onClick={submit}>
          {saving ? '...' : 'Сохранить'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}
