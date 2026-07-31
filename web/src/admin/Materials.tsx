/** Materials catalog: list, create, edit, delete materials. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton } from './ui';

interface Material {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  defaultUnit: string | null;
  characteristics: string | null;
  brand: string | null;
  status: string;
}

const UNIT_OPTIONS = ['шт', 'кг', 'г', 'л', 'м', 'т', 'м²', 'рулон', 'упак'];

function unitOptions(current = '') {
  return current && !UNIT_OPTIONS.includes(current) ? [current, ...UNIT_OPTIONS] : UNIT_OPTIONS;
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
        + Добавить товар
      </PrimaryBtn>

      {items.length === 0 && <Empty>Товаров нет. Добавьте первый.</Empty>}

      <div className="space-y-2.5">
        {items.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between rounded-2xl border border-line bg-card p-4"
          >
            <button onClick={() => setEditing(m)} className="min-w-0 flex-1 text-left">
              <div className="text-sm font-semibold text-fg">{m.name}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {m.sku && <Pill tone="muted">Код: {m.sku}</Pill>}
                {m.category && <Pill tone="system">{m.category}</Pill>}
                {m.defaultUnit && <Pill tone="system">{m.defaultUnit}</Pill>}
                {m.brand && <Pill tone="muted">{m.brand}</Pill>}
              </div>
              {m.characteristics && <div className="mt-1 text-xs text-muted">{m.characteristics}</div>}
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
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('');
  const [characteristics, setCharacteristics] = useState('');
  const [brand, setBrand] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.admin.createMaterial({
        name: name.trim(),
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(unit.trim() ? { defaultUnit: unit.trim() } : {}),
        ...(characteristics.trim() ? { characteristics: characteristics.trim() } : {}),
        ...(brand.trim() ? { brand: brand.trim() } : {}),
      });
      setName(''); setSku(''); setCategory(''); setUnit(''); setCharacteristics(''); setBrand('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} title="Новый товар" onClose={onClose}>
      <Label>Наименование</Label>
      <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Болт М8×40" />
      <div className="mt-4">
        <Label>Код</Label>
        <Field value={sku} onChange={(e) => setSku(e.target.value)} placeholder="напр. BLT-M8-40" />
      </div>
      <div className="mt-4">
        <Label>Категория</Label>
        <Field value={category} onChange={(e) => setCategory(e.target.value)} placeholder="напр. Крепёж" />
      </div>
      <div className="mt-4">
        <Label>Единица измерения</Label>
        <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">—</option>
          {unitOptions(unit).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>
      </div>
      <div className="mt-4">
        <Label>Характеристики</Label>
        <Field value={characteristics} onChange={(e) => setCharacteristics(e.target.value)} placeholder="Размер, состав, цвет, модель..." />
      </div>
      <div className="mt-4">
        <Label>Бренд</Label>
        <Field value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="напр. Bosch" />
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
  const [category, setCategory] = useState(material.category ?? '');
  const [unit, setUnit] = useState(material.defaultUnit ?? '');
  const [characteristics, setCharacteristics] = useState(material.characteristics ?? '');
  const [brand, setBrand] = useState(material.brand ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.admin.updateMaterial(material.id, {
        name: name.trim(),
        sku: sku.trim() || undefined,
        category: category.trim() || undefined,
        defaultUnit: unit.trim() || undefined,
        characteristics: characteristics.trim() || undefined,
        brand: brand.trim() || undefined,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open title={`Товар: ${material.name}`} onClose={onClose}>
      <Label>Наименование</Label>
      <Field value={name} onChange={(e) => setName(e.target.value)} />
      <div className="mt-4">
        <Label>Код</Label>
        <Field value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Код" />
      </div>
      <div className="mt-4">
        <Label>Категория</Label>
        <Field value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Категория" />
      </div>
      <div className="mt-4">
        <Label>Единица измерения</Label>
        <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="">—</option>
          {unitOptions(unit).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>
      </div>
      <div className="mt-4">
        <Label>Характеристики</Label>
        <Field value={characteristics} onChange={(e) => setCharacteristics(e.target.value)} placeholder="Характеристики" />
      </div>
      <div className="mt-4">
        <Label>Бренд</Label>
        <Field value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Бренд" />
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
