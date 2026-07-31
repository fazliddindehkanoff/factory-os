import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useI18n } from '../i18n';
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
  neededDate?: string | null;
  obyekt?: string | null;
  requesterName?: string | null;
  departmentName?: string | null;
  itemsCount?: number;
  actions: { action: string; label: string }[];
}

const WAREHOUSE_STOCK_ACTIONS = new Set(['wh_in_stock', 'wh_partial', 'wh_out_of_stock']);
const isHiddenProcurementTransfer = (a: { action: string; label: string }) => a.action === 'assign_procurement' && a.label === 'Передать снабженцу';
const isHiddenProcurementIntake = (a: { action: string; label: string }) => a.action === 'accept_to_work' && a.label === 'Принять в работу';

function displayInboxActions(status: string, actions: { action: string; label: string }[]): { action: string; label: string }[] {
  const visible = actions.filter((a) => !isHiddenProcurementTransfer(a) && !isHiddenProcurementIntake(a));
  if (status !== 'warehouse_check' || !visible.some((a) => WAREHOUSE_STOCK_ACTIONS.has(a.action))) return visible;
  return [
    { action: 'wh_in_stock', label: 'Далее' },
    ...visible.filter((a) => !WAREHOUSE_STOCK_ACTIONS.has(a.action)),
  ];
}

// Лист Excel №5: карточка показывает № заявки и сведения (объект/отдел/даты), а
// не наименование товара. dd.mm — короткая дата для «Создана».
function shortDate(iso?: string | null, locale = 'ru-RU'): string | null {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }); } catch { return null; }
}

const PRIORITY_TAG: Record<string, { label: string; danger?: boolean }> = {
  low: { label: 'Низкая' },
  normal: { label: 'Стандартная' },
  high: { label: 'Срочная', danger: true },
  urgent: { label: 'Аварийная', danger: true },
  critical: { label: 'Критичная', danger: true },
};

function waitingSince(createdAt: string | null | undefined, tl: (text: string) => string): string | null {
  if (!createdAt) return null;
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  if (days <= 0) return tl('сегодня');
  if (days === 1) return tl('ждёт 1 день');
  return tl(`ждёт ${days} дн.`);
}

export function InboxScreen({ onOpen, permissions, tick = 0 }: { onOpen: (id: string) => void; permissions?: string[]; tick?: number }) {
  const { lang, tl } = useI18n();
  const locale = lang === 'uz' ? 'uz-UZ' : lang === 'tr' ? 'tr-TR' : lang === 'en' ? 'en-US' : 'ru-RU';
  const hasApprovalPerms = permissions ? INBOX_ACTOR_PERMS.some((p) => permissions.includes(p)) : true;
  const [rows, setRows] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // №8: обновляемся на общем 30с-тике (тихо, без сброса списка) — иначе экран
    // застывает на моменте открытия и расходится с KPI дашборда.
    if (hasApprovalPerms) {
      api.inbox().then((r) => { setRows(r); setError(null); }).catch((e) => setError((e as Error).message));
    }
  }, [hasApprovalPerms, tick]);
  if (!hasApprovalPerms) {
    return (
      <div>
        <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px' }}>
          <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>
            {tl('Согласования')}
          </span>
        </div>
        <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="shield" size={34} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>{tl('У вас нет прав на согласование')}</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 250 }}>{tl('Обратитесь к администратору для получения необходимых прав.')}</div>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>
          {tl('Ждут моего решения')} {rows ? `· ${rows.length}` : ''}
        </span>
      </div>
      {error && <div style={{ padding: '0 16px' }}><Err>{error}</Err></div>}
      {!rows && !error && <div style={{ padding: '4px 16px' }}><Skeleton /></div>}
      {rows && rows.length === 0 && (
        <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="checkCircle" size={34} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>{tl('Входящих нет')}</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 250 }}>{tl('Сейчас нет заявок, требующих вашего действия.')}</div>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ padding: '4px 16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((r) => (
            <button key={r.id} onClick={() => onOpen(r.id)} style={{ textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  {/* Лист Excel №5: № заявки — заголовок карточки, объект — под ним. */}
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, color: 'var(--fg)', fontWeight: 700 }}>{r.requestNumber}</div>
                  {r.obyekt && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginTop: 4 }}>{r.obyekt}</div>}
                </div>
                <StatusPill status={r.status} />
              </div>
              {/* №10: основные теги для решения — отдел снабжения, автор, срочность, даты, позиции, сумма.
                  Разделитель «·» ставится между элементами (не перед первым), поэтому
                  строка без отдела больше не начинается с висящей точки. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 12, color: 'var(--fg2)' }}>
                {(() => {
                  const parts: ReactNode[] = [];
                  if (r.departmentName) parts.push(<span key="dep">{r.departmentName}</span>);
                  if (r.requesterName) parts.push(<span key="req">{r.requesterName}</span>);
                  if (r.priority && PRIORITY_TAG[r.priority]) parts.push(
                    <span key="pri" style={{ fontWeight: 700, color: PRIORITY_TAG[r.priority].danger ? 'var(--danger)' : 'var(--fg2)' }}>{tl(PRIORITY_TAG[r.priority].label)}</span>,
                  );
                  if (shortDate(r.createdAt, locale)) parts.push(<span key="cr">{tl('создана')} {shortDate(r.createdAt, locale)}</span>);
                  if (waitingSince(r.createdAt, tl)) parts.push(<span key="wa">{waitingSince(r.createdAt, tl)}</span>);
                  if ((r.itemsCount ?? 0) > 0) parts.push(<span key="it">{tl(`позиций: ${r.itemsCount}`)}</span>);
                  if (r.estimatedAmount != null && r.estimatedAmount > 0) parts.push(
                    <span key="am" style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: 'var(--fg)' }}>{Number(r.estimatedAmount).toLocaleString('ru-RU')}</span>,
                  );
                  return parts.map((node, i) => (
                    <span key={i} style={{ display: 'inline-flex', gap: 6 }}>{i > 0 && <span style={{ color: 'var(--fg3)' }}>·</span>}{node}</span>
                  ));
                })()}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {displayInboxActions(r.status, r.actions).map((a) => (
                  <span key={a.action} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 8, padding: '4px 9px' }}>{tl(a.label)}</span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
