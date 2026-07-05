import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Err, Skeleton, StatusPill, INBOX_ACTOR_PERMS } from './shared';

interface InboxItem {
  id: string;
  requestNumber: string;
  title: string;
  status: string;
  statusLabel: string;
  estimatedAmount: number | null;
  priority?: string | null;
  createdAt?: string | null;
  requesterName?: string | null;
  departmentName?: string | null;
  itemsCount?: number;
  actions: { action: string; label: string }[];
}

const PRIORITY_TAG: Record<string, { label: string; danger?: boolean }> = {
  low: { label: 'Низкая' },
  normal: { label: 'Стандартная' },
  high: { label: 'Срочная', danger: true },
  urgent: { label: 'Аварийная', danger: true },
  critical: { label: 'Критичная', danger: true },
};

function waitingSince(createdAt?: string | null): string | null {
  if (!createdAt) return null;
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'ждёт 1 день';
  return `ждёт ${days} дн.`;
}

export function InboxScreen({ onOpen, permissions }: { onOpen: (id: string) => void; permissions?: string[] }) {
  const hasApprovalPerms = permissions ? INBOX_ACTOR_PERMS.some((p) => permissions.includes(p)) : true;
  const [rows, setRows] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (hasApprovalPerms) {
      api.inbox().then(setRows).catch((e) => setError((e as Error).message));
    }
  }, [hasApprovalPerms]);
  if (!hasApprovalPerms) {
    return (
      <div>
        <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px' }}>
          <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>
            Согласования
          </span>
        </div>
        <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="shield" size={34} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>У вас нет прав на согласование</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 250 }}>Обратитесь к администратору для получения необходимых прав.</div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>
          Ждут моего решения {rows ? `· ${rows.length}` : ''}
        </span>
      </div>
      {error && <div style={{ padding: '0 16px' }}><Err>{error}</Err></div>}
      {!rows && !error && <div style={{ padding: '4px 16px' }}><Skeleton /></div>}
      {rows && rows.length === 0 && (
        <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="checkCircle" size={34} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>Входящих нет</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 250 }}>Сейчас нет заявок, требующих вашего действия.</div>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ padding: '4px 16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((r) => (
            <button key={r.id} onClick={() => onOpen(r.id)} style={{ textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--fg2)', fontWeight: 500 }}>{r.requestNumber}</span>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)', marginTop: 5, letterSpacing: '-.01em' }}>{r.title || 'Без названия'}</div>
                </div>
                <StatusPill status={r.status} />
              </div>
              {/* №10: основные теги для решения — автор, отдел, срочность, возраст, позиции, сумма */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 12, color: 'var(--fg2)' }}>
                {r.requesterName && <span>{r.requesterName}</span>}
                {r.departmentName && <span>· {r.departmentName}</span>}
                {r.priority && PRIORITY_TAG[r.priority] && (
                  <span style={{ fontWeight: 700, color: PRIORITY_TAG[r.priority].danger ? 'var(--danger)' : 'var(--fg2)' }}>
                    · {PRIORITY_TAG[r.priority].label}
                  </span>
                )}
                {waitingSince(r.createdAt) && <span>· {waitingSince(r.createdAt)}</span>}
                {(r.itemsCount ?? 0) > 0 && <span>· позиций: {r.itemsCount}</span>}
                {r.estimatedAmount != null && r.estimatedAmount > 0 && (
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: 'var(--fg)' }}>
                    · {Number(r.estimatedAmount).toLocaleString('ru-RU')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {r.actions.map((a) => (
                  <span key={a.action} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 8, padding: '4px 9px' }}>{a.label}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
