/** Audit log viewer: paginated list of all admin/lifecycle actions. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, Err, Pill, Skeleton } from './ui';

interface AuditEntry {
  id: string;
  action: string;
  module: string | null;
  entityType: string | null;
  entityId: string | null;
  comment: string | null;
  source: string | null;
  createdAt: string;
  userName: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  'request.created': 'Заявка создана',
  'request.edited': 'Заявка изменена',
  'request.approve': 'Согласовано',
  'request.reject': 'Отклонено',
  'request.wh_in_stock': 'В наличии',
  'request.wh_out_of_stock': 'Нет в наличии',
  'request.add_quotation': 'Добавлено КП',
  'request.select_supplier': 'Выбран поставщик',
  'request.mark_paid': 'Оплачено',
  'request.mark_arrived': 'Доставлено',
  'request.receive_goods': 'Принято',
  'request.issue': 'Выдано',
  'request.close': 'Закрыто',
  'approval.approved': 'Согласование: одобрено',
  'approval.rejected': 'Согласование: отклонено',
  'role.assigned': 'Права назначены',
  'role.revoked': 'Права сняты',
  'role.deleted': 'Набор прав удалён',
  'role.permissions_updated': 'Набор прав изменён',
  'user.invited': 'Пользователь добавлен',
  'user.deleted': 'Пользователь удалён',
  'user.archived': 'Пользователь архивирован',
  'user.reactivated': 'Пользователь восстановлен',
  'department.deleted': 'Отдел удалён',
  'warehouse.deleted': 'Склад удалён',
  'factory.created': 'Завод создан',
  'factory.deleted': 'Завод удалён',
  'material.created': 'Материал создан',
  'material.deleted': 'Материал удалён',
  'form_field.created': 'Поле формы создано',
  'form_field.deleted': 'Поле формы удалено',
};

const MODULE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'system'> = {
  lifecycle: 'accent',
  requests: 'accent',
  approvals: 'warning',
  admin: 'system',
  warehouse: 'success',
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

const PAGE = 50;

export function AuditLog() {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback((offset = 0, append = false) => {
    setLoading(true);
    api.admin
      .audit({ limit: PAGE, offset })
      .then((res: { items: AuditEntry[]; hasMore: boolean }) => {
        setItems((prev) => append ? [...(prev ?? []), ...res.items] : res.items);
        setHasMore(res.hasMore);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error && !items) return <Err>{error}</Err>;
  if (!items) return <Skeleton />;

  return (
    <div className="space-y-3">
      {error && <Err>{error}</Err>}

      {items.length === 0 && <Empty>Нет записей в журнале аудита.</Empty>}

      {items.map((e) => (
        <div key={e.id} className="rounded-2xl border border-line bg-card p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-fg">
                {ACTION_LABEL[e.action] ?? e.action}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {e.module && <Pill tone={MODULE_TONE[e.module] ?? 'muted'}>{e.module}</Pill>}
                {e.entityType && <Pill tone="muted">{e.entityType}</Pill>}
                {e.source && <Pill tone="system">{e.source}</Pill>}
              </div>
            </div>
            <div className="flex-none text-right">
              <div className="font-mono text-xs text-fg3">{fmtDate(e.createdAt)}</div>
              {e.userName && <div className="mt-1 text-xs font-medium text-fg2">{e.userName}</div>}
            </div>
          </div>
          {e.comment && (
            <div className="mt-2 text-xs text-fg2">{e.comment}</div>
          )}
        </div>
      ))}

      {hasMore && (
        <button
          onClick={() => load(items.length, true)}
          disabled={loading}
          className="w-full rounded-xl border border-line bg-card py-3 text-sm font-semibold text-accent active:scale-95 disabled:opacity-50"
        >
          {loading ? 'Загрузка...' : 'Показать ещё'}
        </button>
      )}
    </div>
  );
}
