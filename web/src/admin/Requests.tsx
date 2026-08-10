import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, Err, MiniBtn, Skeleton } from './ui';

interface AdminRequestRow {
  id: string;
  requestNumber: string;
  title: string | null;
  status: string;
  requesterName: string | null;
  createdAt: string;
}

export function RequestsAdmin() {
  const [rows, setRows] = useState<AdminRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.admin.requests().then(setRows).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (row: AdminRequestRow) => {
    if (!window.confirm(`Удалить заявку ${row.requestNumber}? Она исчезнет у пользователей, но останется в базе данных.`)) return;
    setBusy(true);
    try {
      await api.admin.deleteRequest(row.id);
      setRows((current) => current?.filter((item) => item.id !== row.id) ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    if (!rows?.length) return;
    if (!window.confirm(`Удалить все заявки (${rows.length})? Они исчезнут у пользователей, но останутся в базе данных.`)) return;
    setBusy(true);
    try {
      await api.admin.deleteAllRequests();
      setRows([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!rows && !error) return <Skeleton />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-fg">Управление заявками</div>
          <div className="mt-1 text-xs text-fg3">Удалённые записи сохраняются в базе и журнале аудита.</div>
        </div>
        {!!rows?.length && (
          <button disabled={busy} onClick={removeAll} className="flex-none rounded-xl bg-danger/15 px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50">
            Удалить все
          </button>
        )}
      </div>

      {error && <Err>{error}</Err>}
      {rows?.length === 0 && <Empty>Активных заявок нет.</Empty>}
      {rows?.map((row) => (
        <div key={row.id} className="rounded-2xl border border-line bg-card p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-xs font-semibold text-accent">{row.requestNumber}</div>
              <div className="mt-1 truncate text-sm font-semibold text-fg">{row.title || 'Без названия'}</div>
              <div className="mt-1 text-xs text-fg3">
                {row.requesterName || '—'} · {new Date(row.createdAt).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' })} · {row.status}
              </div>
            </div>
            <MiniBtn disabled={busy} onClick={() => remove(row)} className="bg-danger/15 text-danger">Удалить</MiniBtn>
          </div>
        </div>
      ))}
    </div>
  );
}
