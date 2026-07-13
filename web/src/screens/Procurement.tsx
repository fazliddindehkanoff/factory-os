/** Procurement: queue of requests on a procurement step + the suppliers directory. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Skeleton } from '../admin/ui';

interface Supplier {
  id: string;
  name: string;
  inn: string | null;
  phone: string | null;
  email: string | null;
  contactPerson: string | null;
  category: string | null;
  status: string;
}
interface QueueRequest {
  id: string;
  requestNumber: string;
  title: string | null;
  // Лист Excel №5: карточка показывает № + объект/отдел/даты, а не наименование товара.
  status?: string;
  obyekt?: string | null;
  departmentNameResolved?: string | null;
  departmentName?: string | null;
  neededDate?: string | null;
  createdAt?: string | null;
  customFields?: Record<string, unknown> | null;
}

function qDate(iso?: string | null): string | null {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }); } catch { return null; }
}

type Tab = 'queue' | 'suppliers';

export function ProcurementScreen({ canManage, onOpen }: { canManage: boolean; onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('queue');
  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', gap: 6 }}>
        {(['queue', 'suppliers'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '9px 0',
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: tab === t ? 'var(--accent)' : 'var(--card)',
              color: tab === t ? '#fff' : 'var(--fg2)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t === 'queue' ? 'Очередь' : 'Поставщики'}
          </button>
        ))}
      </div>
      {tab === 'queue' ? <QueueTab onOpen={onOpen} /> : <SuppliersTab canManage={canManage} />}
    </div>
  );
}

function QueueTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<QueueRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.procurement.queue().then(setItems).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <Err>{error}</Err>;
  if (!items) return <Skeleton />;
  if (items.length === 0) return <Empty>Заявок в закупке нет.</Empty>;
  return (
    <div className="space-y-2.5">
      {items.map((r) => {
        const obyekt = r.obyekt ?? (r.customFields && typeof r.customFields === 'object' ? (r.customFields.obyekt as string | undefined) ?? null : null);
        const dept = r.departmentNameResolved ?? r.departmentName ?? null;
        const created = qDate(r.createdAt);
        return (
          <button key={r.id} onClick={() => onOpen(r.id)} className="w-full rounded-2xl border border-line bg-card p-4 text-left">
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-sm font-bold text-fg">{r.requestNumber}</div>
              <Pill tone="system">В закупке</Pill>
            </div>
            <div className="mt-2 space-y-1 text-xs text-fg2">
              {obyekt && <div>Объект: <span className="font-semibold text-fg">{obyekt}</span></div>}
              {dept && <div>Отдел снабжения: <span className="font-semibold text-fg">{dept}</span></div>}
              <div className="flex flex-wrap gap-x-3">
                {created && <span>Создана {created}</span>}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SuppliersTab({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<Supplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);

  const load = useCallback(() => {
    api.suppliers.list().then(setItems).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const archive = async (s: Supplier) => {
    if (!(await confirmDialog(`Архивировать «${s.name}»?`))) return;
    try {
      await api.suppliers.archive(s.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !items) return <Err>{error}</Err>;
  if (!items) return <Skeleton />;

  return (
    <div className="space-y-3">
      {error && <Err>{error}</Err>}
      {canManage && (
        <PrimaryBtn className="w-full" onClick={() => setAddOpen(true)}>
          + Добавить поставщика
        </PrimaryBtn>
      )}
      {items.length === 0 && <Empty>Поставщиков нет.</Empty>}
      <div className="space-y-2.5">
        {items.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-2xl border border-line bg-card p-4">
            <button onClick={() => canManage && setEditing(s)} className="min-w-0 flex-1 text-left">
              <div className="text-sm font-semibold text-fg">{s.name}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {s.inn && <Pill tone="muted">ИНН {s.inn}</Pill>}
                {s.phone && <Pill tone="system">{s.phone}</Pill>}
                {s.category && <Pill tone="system">{s.category}</Pill>}
              </div>
            </button>
            {canManage && (
              <MiniBtn className="bg-danger/15 text-danger" onClick={() => archive(s)}>
                Архив
              </MiniBtn>
            )}
          </div>
        ))}
      </div>
      <SupplierSheet open={addOpen} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); load(); }} setError={setError} />
      {editing && (
        <SupplierSheet supplier={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} setError={setError} />
      )}
    </div>
  );
}

function SupplierSheet({
  supplier, open, onClose, onDone, setError,
}: {
  supplier?: Supplier;
  open?: boolean;
  onClose: () => void;
  onDone: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState(supplier?.name ?? '');
  const [inn, setInn] = useState(supplier?.inn ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [email, setEmail] = useState(supplier?.email ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const data = {
        name: name.trim(),
        inn: inn.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
      };
      if (supplier) await api.suppliers.update(supplier.id, data);
      else await api.suppliers.create(data);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={supplier ? true : !!open} title={supplier ? `Поставщик: ${supplier.name}` : 'Новый поставщик'} onClose={onClose}>
      <Label>Название</Label>
      <Field value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. ООО Поставка" />
      <div className="mt-4">
        <Label>ИНН</Label>
        <Field value={inn} onChange={(e) => setInn(e.target.value)} placeholder="необязательно" />
      </div>
      <div className="mt-4">
        <Label>Телефон</Label>
        <Field value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="необязательно" />
      </div>
      <div className="mt-4">
        <Label>Email</Label>
        <Field value={email} onChange={(e) => setEmail(e.target.value)} placeholder="необязательно" />
      </div>
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>Отмена</GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !name.trim()} onClick={submit}>
          {saving ? '...' : supplier ? 'Сохранить' : 'Добавить'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}
