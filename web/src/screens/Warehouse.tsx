import { useState, useEffect, type CSSProperties } from 'react';
import { api } from '../api';
import { Icon } from '../icons';

// ── Types ────────────────────────────────────────────────────────────────────
interface Balance {
  id: string;
  materialId: string;
  warehouseId: string;
  availableQty: number;
  reservedQty: number;
  minQty: number;
  materialName: string;
  materialUnit: string;
  warehouseName: string;
}

interface Movement {
  id: string;
  holdingId: string;
  warehouseId: string;
  materialId: string;
  movementType: string;
  quantity: number;
  requestId: string | null;
  performedBy: string | null;
  reason: string | null;
  source: string | null;
  createdAt: string;
  materialName: string | null;
  materialUnit: string | null;
}

type Tab = 'balances' | 'receive' | 'issue' | 'journal';

const TABS: { key: Tab; label: string }[] = [
  { key: 'balances', label: 'Остатки' },
  { key: 'receive', label: 'Приёмка' },
  { key: 'issue', label: 'Выдача' },
  { key: 'journal', label: 'Журнал' },
];

// ── Styles ───────────────────────────────────────────────────────────────────
const card: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  boxShadow: 'var(--shadowSm)',
  overflow: 'hidden',
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  fontSize: 15,
  fontWeight: 500,
  border: '1.5px solid var(--border)',
  borderRadius: 11,
  background: 'var(--card)',
  color: 'var(--fg)',
  outline: 'none',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  boxSizing: 'border-box',
};

const btnPrimary = (disabled: boolean): CSSProperties => ({
  width: '100%',
  padding: 14,
  borderRadius: 11,
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 15,
  fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
});

const skel: CSSProperties = {
  height: 62,
  borderRadius: 14,
  background: 'var(--chip)',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi}`;
};

const movementBadge = (type: string): { label: string; fg: string; bg: string } => {
  switch (type) {
    case 'income':
      return { label: 'Приход', fg: 'var(--success)', bg: 'var(--success-bg)' };
    case 'outcome':
      return { label: 'Расход', fg: 'var(--danger)', bg: 'var(--danger-bg)' };
    case 'adjustment':
      return { label: 'Коррекция', fg: 'var(--accent)', bg: 'var(--accent-bg)' };
    default:
      return { label: type, fg: 'var(--fg2)', bg: 'var(--chip)' };
  }
};

// ── Component ────────────────────────────────────────────────────────────────
export function WarehouseScreen() {
  const [tab, setTab] = useState<Tab>('balances');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '0 0 24px' }}>
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          padding: '0 2px',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: '0 0 auto',
              padding: '9px 16px',
              borderRadius: 11,
              border: `1.5px solid ${tab === t.key ? 'var(--accent)' : 'var(--border)'}`,
              background: tab === t.key ? 'var(--accent-bg)' : 'var(--card)',
              color: tab === t.key ? 'var(--accent)' : 'var(--fg2)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'balances' && <BalancesTab />}
      {tab === 'receive' && <OperationForm mode="receive" />}
      {tab === 'issue' && <OperationForm mode="issue" />}
      {tab === 'journal' && <JournalTab />}
    </div>
  );
}

// ── Balances ─────────────────────────────────────────────────────────────────
function BalancesTab() {
  const [data, setData] = useState<Balance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.warehouse
      .balances()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  const filtered = data?.filter(
    (b) =>
      b.materialName.toLowerCase().includes(search.toLowerCase()) ||
      b.warehouseName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <>
      {/* Search */}
      <div style={{ position: 'relative' }}>
        <span
          style={{
            position: 'absolute',
            left: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--fg3)',
            pointerEvents: 'none',
          }}
        >
          <Icon name="search" size={18} />
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по материалу или складу..."
          style={{ ...inputStyle, paddingLeft: 42 }}
        />
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            borderRadius: 14,
            background: 'var(--danger-bg)',
            color: 'var(--danger)',
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {!data && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-pulse" style={skel} />
          ))}
        </div>
      )}

      {/* Empty */}
      {data && filtered && filtered.length === 0 && (
        <div
          style={{
            ...card,
            border: '1px dashed var(--border)',
            padding: '24px 16px',
            textAlign: 'center',
            fontSize: 13,
            color: 'var(--fg3)',
          }}
        >
          {search ? 'Ничего не найдено' : 'Нет остатков на складе'}
        </div>
      )}

      {/* List */}
      {filtered && filtered.length > 0 && (
        <div style={{ ...card }}>
          {filtered.map((b, i) => {
            const low = b.availableQty <= b.minQty;
            return (
              <div
                key={b.id}
                style={{
                  padding: '13px 15px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderTop: i > 0 ? '1px solid var(--line)' : 'none',
                }}
              >
                {/* Icon */}
                <span
                  style={{
                    width: 38,
                    height: 38,
                    flex: 'none',
                    borderRadius: 11,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: low ? 'var(--danger-bg)' : 'var(--success-bg)',
                    color: low ? 'var(--danger)' : 'var(--success)',
                  }}
                >
                  <Icon name="box" size={18} />
                </span>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: 'var(--fg)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {b.materialName}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>
                    {b.warehouseName} &middot; {b.materialUnit}
                  </div>
                </div>

                {/* Quantity */}
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      fontFamily: "'IBM Plex Mono', monospace",
                      color: low ? 'var(--danger)' : 'var(--success)',
                    }}
                  >
                    {b.availableQty}
                  </div>
                  {b.reservedQty > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--fg3)', marginTop: 1 }}>
                      резерв: {b.reservedQty}
                    </div>
                  )}
                  {b.minQty > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--fg3)', marginTop: 1 }}>
                      мин: {b.minQty}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Receive / Issue form ─────────────────────────────────────────────────────
interface MatOpt { id: string; name: string; defaultUnit: string | null; }
interface WhOpt { id: string; name: string; }

function OperationForm({ mode }: { mode: 'receive' | 'issue' }) {
  const [materialId, setMaterialId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [materials, setMaterials] = useState<MatOpt[]>([]);
  const [warehouses, setWarehouses] = useState<WhOpt[]>([]);

  useEffect(() => {
    api.admin.materials().then((m: MatOpt[]) => setMaterials(m)).catch(() => {});
    api.config().then((c: { warehouses?: WhOpt[] }) => setWarehouses(c.warehouses ?? [])).catch(() => {});
  }, []);

  const canSubmit = materialId !== '' && Number(quantity) > 0 && !saving;

  const submit = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const payload = {
        materialId: materialId.trim(),
        quantity: Number(quantity),
        ...(warehouseId.trim() ? { warehouseId: warehouseId.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      if (mode === 'receive') {
        await api.warehouse.receive(payload);
      } else {
        await api.warehouse.issue(payload);
      }
      setSuccess(true);
      setMaterialId('');
      setWarehouseId('');
      setQuantity('');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Success */}
      {success && (
        <div
          style={{
            borderRadius: 14,
            background: 'var(--success-bg)',
            color: 'var(--success)',
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.45,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Icon name="check" size={16} sw={2.5} />
          {mode === 'receive' ? 'Материал принят на склад' : 'Материал выдан со склада'}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            borderRadius: 14,
            background: 'var(--danger-bg)',
            color: 'var(--danger)',
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}

      {/* Material */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 6, display: 'block' }}>
          Материал <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        {materials.length > 0 ? (
          <select value={materialId} onChange={(e) => setMaterialId(e.target.value)} style={{ ...inputStyle, appearance: 'none', cursor: 'pointer' }}>
            <option value="">-- Выберите материал --</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.defaultUnit ? ` (${m.defaultUnit})` : ''}</option>
            ))}
          </select>
        ) : (
          <input value={materialId} onChange={(e) => setMaterialId(e.target.value)} placeholder="ID материала (каталог пуст)" style={inputStyle} />
        )}
      </div>

      {/* Warehouse */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 6, display: 'block' }}>
          Склад <span style={{ fontSize: 11, color: 'var(--fg3)', fontWeight: 400 }}>(необяз.)</span>
        </label>
        {warehouses.length > 0 ? (
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={{ ...inputStyle, appearance: 'none', cursor: 'pointer' }}>
            <option value="">-- Любой склад --</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        ) : (
          <input value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="ID склада (необязательно)" style={inputStyle} />
        )}
      </div>

      {/* Quantity */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 6, display: 'block' }}>
          Количество <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="0"
          style={{ ...inputStyle, fontFamily: "'IBM Plex Mono', monospace" }}
        />
      </div>

      {/* Reason */}
      <div>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 6, display: 'block' }}>
          Причина <span style={{ fontSize: 11, color: 'var(--fg3)', fontWeight: 400 }}>(необяз.)</span>
        </label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Укажите причину"
          style={inputStyle}
        />
      </div>

      {/* Submit */}
      <button onClick={submit} disabled={!canSubmit} style={btnPrimary(!canSubmit)}>
        {saving
          ? 'Отправка...'
          : mode === 'receive'
            ? 'Принять на склад'
            : 'Выдать со склада'}
      </button>
    </div>
  );
}

// ── Journal ──────────────────────────────────────────────────────────────────
function JournalTab() {
  const [data, setData] = useState<Movement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.warehouse
      .movements()
      .then((rows: Movement[]) => setData(rows.slice(0, 100)))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      {/* Error */}
      {error && (
        <div
          style={{
            borderRadius: 14,
            background: 'var(--danger-bg)',
            color: 'var(--danger)',
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}

      {/* Loading */}
      {!data && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse" style={skel} />
          ))}
        </div>
      )}

      {/* Empty */}
      {data && data.length === 0 && (
        <div
          style={{
            ...card,
            border: '1px dashed var(--border)',
            padding: '24px 16px',
            textAlign: 'center',
            fontSize: 13,
            color: 'var(--fg3)',
          }}
        >
          Нет записей в журнале
        </div>
      )}

      {/* List */}
      {data && data.length > 0 && (
        <div style={{ ...card }}>
          {data.map((m, i) => {
            const badge = movementBadge(m.movementType);
            return (
              <div
                key={m.id}
                style={{
                  padding: '13px 15px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  borderTop: i > 0 ? '1px solid var(--line)' : 'none',
                }}
              >
                {/* Badge */}
                <span
                  style={{
                    flex: 'none',
                    padding: '4px 10px',
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    background: badge.bg,
                    color: badge.fg,
                    whiteSpace: 'nowrap',
                    marginTop: 2,
                  }}
                >
                  {badge.label}
                </span>

                {/* Details */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {m.materialName && (
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 3 }}>
                      {m.materialName}{m.materialUnit ? ` (${m.materialUnit})` : ''}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        fontFamily: "'IBM Plex Mono', monospace",
                        color: 'var(--fg)',
                      }}
                    >
                      {m.quantity}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--fg3)' }}>
                      {fmtDate(m.createdAt)}
                    </span>
                  </div>
                  {m.reason && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--fg2)',
                        marginTop: 3,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {m.reason}
                    </div>
                  )}
                  {m.source && (
                    <div style={{ fontSize: 11, color: 'var(--fg3)', marginTop: 2 }}>
                      {m.source}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
