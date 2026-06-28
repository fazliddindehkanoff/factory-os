import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, clearToken, getToken, setToken, type CreateRequestData } from './api';
import { getTelegram } from './telegram';
import { AdminPanel } from './admin/AdminPanel';
import { Icon, TINT_BG, TINT_FG } from './icons';
import { applyTheme, getTheme, type Theme } from './theme';
import { DASHBOARD_ACTIONS, DASHBOARD_STATS } from './dashboard.config';

const ADMIN_PERMS = ['roles.manage', 'users.manage', 'workflows.manage', 'settings.manage'];
// Perms that let a user act on a request somewhere in the lifecycle → they get the inbox tab.
const INBOX_ACTOR_PERMS = [
  'approvals.approve',
  'warehouse.check_stock',
  'warehouse.reserve',
  'warehouse.receive',
  'warehouse.issue',
  'procurement.quote',
  'procurement.select_supplier',
  'finance.mark_paid',
];

// ── Types ────────────────────────────────────────────────────────────────────
interface Me {
  user: { id: string; fullName: string; holdingId: string | null };
  permissions: string[];
}
interface RequestRow {
  id: string;
  requestNumber: string;
  status: string;
  estimatedAmount: number;
  title: string | null;
  createdAt: string;
}
interface ApprovalRow {
  id: string;
  status: string;
}
interface LifecycleActionBtn {
  action: string;
  label: string;
  pin: boolean;
  comment: boolean;
  amount: boolean;
  quote?: 'add' | 'select' | null;
}
interface QuotationRow {
  id: string;
  supplierName: string;
  amount: number;
  leadTime: string | null;
  note: string | null;
  selected: boolean;
}
interface StatusHistoryRow {
  id: string;
  oldStatus: string | null;
  newStatus: string;
  comment: string | null;
  createdAt: string;
}
interface RequestDetail extends RequestRow {
  items: { id: string; name: string; quantity: string; totalAmount: number }[];
  approvals: ApprovalRow[];
  statusLabel?: string;
  statusHistory?: StatusHistoryRow[];
  quotations?: QuotationRow[];
  actions?: LifecycleActionBtn[];
}
type Screen =
  | { name: 'home' }
  | { name: 'list' }
  | { name: 'create' }
  | { name: 'detail'; id: string }
  | { name: 'approvals' }
  | { name: 'warehouse' }
  | { name: 'menu' }
  | { name: 'admin' };

interface DashboardData {
  myActive: number;
  pendingForMe: number;
  totalActive: number;
  activity: { id: string; requestNumber: string; status: string; title: string | null }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const money = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0);
const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Черновик', cls: 'bg-fg3/20 text-fg2' },
  pending_approval: { label: 'На согласовании', cls: 'bg-warning/15 text-warning' },
  approved: { label: 'Согласована', cls: 'bg-success/15 text-success' },
  rejected: { label: 'Отклонена', cls: 'bg-danger/15 text-danger' },
};
const statusOf = (s: string) => STATUS[s] ?? { label: s, cls: 'bg-fg3/20 text-fg2' };

// ── Root ─────────────────────────────────────────────────────────────────────
interface TenantConfig {
  factoryName: string;
  currency: string;
  theme: string;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [theme, setTheme] = useState<Theme>(getTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const loadMe = useCallback(async () => setMe(await api.me()), []);

  useEffect(() => {
    if (me) api.config().then(setConfig).catch(() => {});
  }, [me]);

  useEffect(() => {
    (async () => {
      try {
        const tg = getTelegram();
        tg?.ready?.();
        tg?.expand?.();
        if (getToken()) await loadMe();
        else if (tg?.initData) {
          const r = await api.loginTelegram(tg.initData);
          setToken(r.token);
          await loadMe();
        }
      } catch (e) {
        clearToken();
        setAuthError((e as Error).message);
      } finally {
        setBooting(false);
      }
    })();
  }, [loadMe]);

  if (booting) return <Centered>Загрузка…</Centered>;
  if (!me)
    return (
      <DevLogin
        error={authError}
        onLoggedIn={async () => {
          setBooting(true);
          try {
            await loadMe();
            setAuthError(null);
          } catch (e) {
            setAuthError((e as Error).message);
          } finally {
            setBooting(false);
          }
        }}
      />
    );

  const TITLES: Record<Screen['name'], string> = {
    home: 'Главная',
    list: 'Заявки',
    create: 'Новая заявка',
    detail: 'Заявка',
    approvals: 'Согласования',
    warehouse: 'Склад',
    menu: 'Меню',
    admin: 'Администрирование',
  };
  const title = TITLES[screen.name];
  const fullBleed = ['home', 'list', 'detail', 'create', 'approvals', 'warehouse'].includes(screen.name);
  const showNav = ['home', 'list', 'approvals', 'warehouse', 'menu', 'admin'].includes(screen.name);
  const iconBtn: CSSProperties = {
    width: 38,
    height: 38,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 11,
    background: 'rgba(255,255,255,.09)',
    color: 'var(--hfg)',
    cursor: 'pointer',
  };

  return (
    <div className="mx-auto flex h-[100dvh] max-w-[560px] flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
      <header style={{ background: 'var(--header)', color: 'var(--hfg)', flex: '0 0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 20px 16px' }}>
          <button
            onClick={() => setScreen({ name: 'home' })}
            style={{ textAlign: 'left', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', minWidth: 0 }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--hfg2)' }}>
              {config?.factoryName ?? 'Factory OS'}
            </div>
            <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title}
            </div>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
            <button aria-label="Сменить тему" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} style={iconBtn}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />
            </button>
            <span style={{ borderRadius: 9, background: 'rgba(255,255,255,.12)', padding: '5px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {me.user.fullName}
            </span>
            <button aria-label="Выйти" onClick={() => { clearToken(); setMe(null); }} style={iconBtn}>
              <Icon name="logout" size={20} />
            </button>
          </div>
        </div>
      </header>

      <main className={fullBleed ? 'flex-1 overflow-y-auto' : 'flex-1 overflow-y-auto p-4'}>
        {!me.user.holdingId && (
          <div className={fullBleed ? 'p-4' : ''}>
            <Note>Вы не привязаны к организации. Попросите администратора назначить вам роль.</Note>
          </div>
        )}
        {screen.name === 'home' && (
          <Home me={me} onNav={setScreen} onOpen={(id) => setScreen({ name: 'detail', id })} />
        )}
        {screen.name === 'list' && (
          <RequestsList
            me={me}
            onCreate={() => setScreen({ name: 'create' })}
            onOpen={(id) => setScreen({ name: 'detail', id })}
          />
        )}
        {screen.name === 'create' && <CreateRequest onDone={() => setScreen({ name: 'list' })} />}
        {screen.name === 'detail' && (
          <RequestDetailView id={screen.id} me={me} onBack={() => setScreen({ name: 'list' })} />
        )}
        {screen.name === 'approvals' && <InboxScreen onOpen={(id) => setScreen({ name: 'detail', id })} />}
        {screen.name === 'warehouse' && <Placeholder icon="box" title="Склад" text="Экран склада (остатки, приёмка, выдача) переносится из дизайна — следующий заход." />}
        {screen.name === 'menu' && <Menu me={me} theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} onLogout={() => { clearToken(); setMe(null); }} />}
        {screen.name === 'admin' && (
          <AdminPanel permissions={me.permissions} onExit={() => setScreen({ name: 'home' })} />
        )}
      </main>

      {showNav && <BottomNav me={me} active={screen.name} onNav={setScreen} />}
    </div>
  );
}

function BottomNav({ me, active, onNav }: { me: Me; active: Screen['name']; onNav: (s: Screen) => void }) {
  const can = (p: string) => me.permissions.includes(p);
  const isAdmin = ADMIN_PERMS.some(can);
  // Anyone who can take a lifecycle action (approve, check stock, quote, pay, receive…)
  // gets the inbox tab — not just final approvers.
  const canAct = INBOX_ACTOR_PERMS.some(can);
  const tabs: { key: Screen['name']; label: string; ic: string }[] = [{ key: 'home', label: 'Главная', ic: 'home' }];
  if (can('requests.view')) tabs.push({ key: 'list', label: 'Заявки', ic: 'file' });
  if (canAct) tabs.push({ key: 'approvals', label: 'Согласования', ic: 'checkCircle' });
  if (isAdmin) tabs.push({ key: 'admin', label: 'Админ', ic: 'shield' });
  else if (can('warehouse.view')) tabs.push({ key: 'warehouse', label: 'Склад', ic: 'box' });
  tabs.push({ key: 'menu', label: 'Меню', ic: 'grid' });

  return (
    <div style={{ flex: '0 0 auto', background: 'var(--card)', borderTop: '1px solid var(--border)', padding: '6px 8px', boxShadow: '0 -2px 14px -8px rgba(16,30,60,.18)' }}>
      <div style={{ display: 'flex' }}>
        {tabs.map((n) => {
          const on = active === n.key;
          return (
            <button
              key={n.key}
              aria-label={n.label}
              onClick={() => onNav({ name: n.key } as Screen)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 2px', border: 'none', borderRadius: 10, background: 'none', cursor: 'pointer', color: on ? 'var(--accent)' : 'var(--fg3)' }}
            >
              <Icon name={n.ic} size={23} sw={on ? 2.2 : 1.9} />
              <span style={{ fontSize: 10, fontWeight: on ? 700 : 500 }}>{n.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Placeholder({ icon, title, text }: { icon: string; title: string; text: string }) {
  return (
    <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={34} />
      </span>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>{title}</div>
      <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 260 }}>{text}</div>
    </div>
  );
}

function Menu({ me, theme, onToggleTheme, onLogout }: { me: Me; theme: Theme; onToggleTheme: () => void; onLogout: () => void }) {
  const rowStyle: CSSProperties = {
    width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: '14px 15px', border: 'none',
    borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left',
  };
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savePin = async () => {
    setSaving(true);
    setPinMsg(null);
    try {
      await api.setPin(pin);
      setPinMsg('PIN сохранён ✓');
      setPin('');
    } catch (e) {
      setPinMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ padding: '16px 16px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: 16, display: 'flex', alignItems: 'center', gap: 13 }}>
        <span style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>
          {(me.user.fullName || '?').slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)' }}>{me.user.fullName}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg2)' }}>{roleLabel(me.permissions)} · {me.permissions.length} прав</div>
        </div>
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', overflow: 'hidden' }}>
        <button onClick={onToggleTheme} style={{ ...rowStyle, borderTop: 'none' }}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
          </span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Тема оформления</span>
          <span style={{ fontSize: 13, color: 'var(--fg2)' }}>{theme === 'dark' ? 'Тёмная' : 'Светлая'}</span>
        </button>
        <button onClick={() => { setPinOpen(true); setPinMsg(null); }} style={rowStyle}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="shield" size={19} />
          </span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>PIN для подписи</span>
          <span style={{ color: 'var(--fg3)' }}><Icon name="chev" size={16} sw={2.2} /></span>
        </button>
        <button onClick={onLogout} style={rowStyle}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--danger-bg)', color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="logout" size={19} />
          </span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--danger)' }}>Выйти</span>
        </button>
      </div>

      {pinOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={() => setPinOpen(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
          <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 6 }}>PIN для подписи</div>
            <div style={{ fontSize: 13, color: 'var(--fg2)', marginBottom: 16, lineHeight: 1.45 }}>4–8 цифр. Нужен для согласования и других действий с подписью.</div>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" type="password" placeholder="••••" style={{ width: '100%', padding: '13px 15px', fontSize: 18, letterSpacing: 6, textAlign: 'center', border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none' }} />
            {pinMsg && <div style={{ marginTop: 10, fontSize: 13, color: pinMsg.includes('✓') ? 'var(--success)' : 'var(--danger)' }}>{pinMsg}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setPinOpen(false)} style={{ flex: 1, padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Закрыть</button>
              <button onClick={savePin} disabled={saving || pin.length < 4} style={{ flex: 1, padding: 14, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving || pin.length < 4 ? 'not-allowed' : 'pointer', opacity: saving || pin.length < 4 ? 0.5 : 1 }}>{saving ? '…' : 'Сохранить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Screens ──────────────────────────────────────────────────────────────────
function roleLabel(perms: string[]): string {
  if (perms.includes('approvals.override')) return 'Учредитель';
  if (perms.includes('roles.manage') || perms.includes('settings.manage')) return 'Администратор';
  if (perms.includes('finance.mark_paid')) return 'Финансы';
  if (perms.includes('procurement.select_supplier')) return 'Закупки';
  if (perms.includes('warehouse.issue')) return 'Склад';
  if (perms.includes('approvals.approve')) return 'Согласующий';
  if (perms.includes('requests.create')) return 'Заявитель';
  return 'Сотрудник';
}

function actTint(status: string): { tint: string; ic: string } {
  switch (status) {
    case 'approved':
      return { tint: 'success', ic: 'check' };
    case 'rejected':
      return { tint: 'danger', ic: 'x' };
    case 'pending_approval':
      return { tint: 'warning', ic: 'checkCircle' };
    default:
      return { tint: 'accent', ic: 'file' };
  }
}

const SECTION_LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--fg2)',
  marginBottom: 12,
};

function Home({
  me,
  onNav,
  onOpen,
}: {
  me: Me;
  onNav: (s: Screen) => void;
  onOpen: (id: string) => void;
}) {
  const [dash, setDash] = useState<DashboardData | null>(null);
  useEffect(() => {
    api.dashboard().then(setDash).catch(() => {});
  }, []);
  const can = (p: string) => me.permissions.includes(p);

  const values: Record<string, number | string> = {
    myActive: dash?.myActive ?? '—',
    pendingForMe: dash?.pendingForMe ?? '—',
    totalActive: dash?.totalActive ?? '—',
  };
  const stats = DASHBOARD_STATS.filter((s) =>
    s.valueKey === 'totalActive' ? can('reports.view') || can('audit.view') : can(s.perm),
  );

  const actions: { label: string; tint: string; ic: string; onClick: () => void }[] = [];
  for (const a of DASHBOARD_ACTIONS) if (can(a.perm)) actions.push({ label: a.label, tint: a.tint, ic: a.ic, onClick: () => onNav({ name: a.go }) });
  if (ADMIN_PERMS.some((p) => can(p)))
    actions.push({ label: 'Администрирование', tint: 'accent', ic: 'gear', onClick: () => onNav({ name: 'admin' }) });

  return (
    <div>
      {/* Greeting — navy, continues the header with no seam */}
      <div style={{ background: 'var(--header)', color: 'var(--hfg)', padding: '4px 20px 46px' }}>
        <div style={{ fontSize: 14, color: 'var(--hfg2)', fontWeight: 500 }}>Добрый день,</div>
        <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.02em', marginTop: 3 }}>{me.user.fullName}</div>
        <div
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 10, padding: '5px 12px', borderRadius: 9, background: 'var(--accent)', fontSize: 12.5, fontWeight: 600, color: '#fff' }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />
          {roleLabel(me.permissions)}
        </div>
      </div>

      {/* Stat cards — overlap up into the navy block */}
      {stats.length > 0 && (
        <div style={{ position: 'relative', marginTop: -32 }}>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', padding: '0 20px 4px', scrollSnapType: 'x mandatory' }}>
            {stats.map((s) => (
              <button
                key={s.label}
                onClick={() => onNav({ name: s.go })}
                style={{ scrollSnapAlign: 'start', flex: '0 0 auto', width: 166, textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: '14px 15px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 9 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TINT_BG[s.tint], color: TINT_FG[s.tint] }}>
                    <Icon name={s.ic} size={19} />
                  </span>
                  <span style={{ color: 'var(--fg3)' }}>
                    <Icon name="chev" size={17} sw={2.2} />
                  </span>
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 30, fontWeight: 600, lineHeight: 1, color: 'var(--fg)' }}>{values[s.valueKey]}</div>
                <div style={{ fontSize: 12.5, color: 'var(--fg2)', fontWeight: 500, lineHeight: 1.25 }}>{s.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      {actions.length > 0 && (
        <div style={{ padding: '24px 20px 0' }}>
          <div style={SECTION_LABEL}>Быстрые действия</div>
          <div style={{ display: 'flex', gap: 12 }}>
            {actions.map((a) => (
              <button
                key={a.label}
                onClick={a.onClick}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 14, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ width: 42, height: 42, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TINT_BG[a.tint], color: TINT_FG[a.tint] }}>
                  <Icon name={a.ic} size={22} sw={a.ic === 'plus' ? 2.4 : 1.9} />
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.2 }}>{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      <div style={{ padding: '24px 20px 24px' }}>
        <div style={SECTION_LABEL}>Последние события</div>
        {!dash && <div className="animate-pulse" style={{ height: 68, borderRadius: 14, background: 'var(--skel)' }} />}
        {dash && dash.activity.length === 0 && (
          <div style={{ background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 14, padding: '24px 16px', textAlign: 'center', fontSize: 13, color: 'var(--fg3)' }}>
            Пока нет событий — здесь появятся обновления по вашим заявкам.
          </div>
        )}
        {dash && dash.activity.length > 0 && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', overflow: 'hidden' }}>
            {dash.activity.map((e, idx) => {
              const t = actTint(e.status);
              return (
                <button
                  key={e.id}
                  onClick={() => onOpen(e.id)}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: '14px 15px', border: 'none', borderTop: idx === 0 ? 'none' : '1px solid var(--line)', background: 'none', cursor: 'pointer' }}
                >
                  <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TINT_BG[t.tint], color: TINT_FG[t.tint] }}>
                    <Icon name={t.ic} size={19} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || e.requestNumber}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>
                      {statusOf(e.status).label} · {e.requestNumber}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestsList({
  me,
  onCreate,
  onOpen,
}: {
  me: Me;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRequests().then(setRows).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>
          Все заявки {rows ? `· ${rows.length}` : ''}
        </span>
        {me.permissions.includes('requests.create') && (
          <button onClick={onCreate} style={{ padding: '8px 13px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            + Создать
          </button>
        )}
      </div>
      {error && <div style={{ padding: '0 16px' }}><Err>{error}</Err></div>}
      {!rows && !error && <div style={{ padding: '4px 16px' }}><Skeleton /></div>}
      {rows && rows.length === 0 && (
        <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="file" size={34} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>Здесь пока пусто</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 240 }}>Заявок нет. Создайте первую с главного экрана.</div>
          {me.permissions.includes('requests.create') && (
            <button onClick={onCreate} style={{ marginTop: 18, padding: '12px 20px', borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              + Новая заявка
            </button>
          )}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ padding: '4px 16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groupByDay(rows).map((g) => (
            <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <DateDivider label={g.label} />
              {g.items.map((r) => {
            const s = statusMeta(r.status);
            return (
              <button
                key={r.id}
                onClick={() => onOpen(r.id)}
                style={{ textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 11 }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: s.color }} />
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--fg2)', fontWeight: 500 }}>{r.requestNumber}</span>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)', marginTop: 5, letterSpacing: '-.01em' }}>{r.title || 'Без названия'}</div>
                  </div>
                  <StatusPill status={r.status} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg2)', fontFamily: "'IBM Plex Mono', monospace" }}>{money(r.estimatedAmount)} UZS</div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--fg3)', fontWeight: 600, marginBottom: 5 }}>
                    <span>{s.label}</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: 'var(--chip)', overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', borderRadius: 3, width: progressOf(r.status), background: s.color }} />
                  </div>
                </div>
              </button>
            );
          })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface InboxItem {
  id: string;
  requestNumber: string;
  title: string;
  status: string;
  statusLabel: string;
  estimatedAmount: number;
  actions: { action: string; label: string }[];
}

/** «Согласования» — requests awaiting THIS user's action (server-computed inbox). */
function InboxScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.inbox().then(setRows).catch((e) => setError((e as Error).message));
  }, []);
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
            <button
              key={r.id}
              onClick={() => onOpen(r.id)}
              style={{ textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--fg2)', fontWeight: 500 }}>{r.requestNumber}</span>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)', marginTop: 5, letterSpacing: '-.01em' }}>{r.title || 'Без названия'}</div>
                </div>
                <StatusPill status={r.status} />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {r.actions.map((a) => (
                  <span key={a.action} style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', borderRadius: 8, padding: '4px 9px' }}>
                    {a.label}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface FormField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'date' | 'checkbox' | 'file';
  system: boolean;
  required: boolean;
  placeholder: string | null;
  options: { value: string; label: string; meta?: string }[];
  step: number;
}

/** Create wizard rendered entirely from the admin-configured schema (/api/form/request_create). */
function CreateRequest({ onDone }: { onDone: () => void }) {
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [idx, setIdx] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submittedNo, setSubmittedNo] = useState<string | null>(null);

  useEffect(() => {
    api
      .form('request_create')
      .then(async (f: { fields?: FormField[] }) => {
        let whs: { id: string; name: string }[] = [];
        try {
          const c = (await api.config()) as { warehouses?: { id: string; name: string }[] };
          whs = c.warehouses ?? [];
        } catch {
          /* warehouses are optional — the form still renders without /config */
        }
        const fs = Array.isArray(f.fields) ? f.fields : [];
        setFields(fs);
        setWarehouses(whs);
        const init: Record<string, string | boolean> = {};
        for (const fld of fs) {
          if (fld.type === 'checkbox') init[fld.key] = false;
          else if (fld.type === 'select') {
            const opts = fld.key === 'warehouse' ? whs.map((w) => ({ value: w.name, label: w.name })) : fld.options;
            init[fld.key] = fld.required && opts[0] ? opts[0].value : '';
          } else init[fld.key] = '';
        }
        setValues(init);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const optionsFor = (f: FormField): { value: string; label: string; meta?: string }[] =>
    f.key === 'warehouse'
      ? warehouses.map((w) => ({ value: w.name, label: w.name }))
      : Array.isArray(f.options)
        ? f.options
        : [];
  const set = (key: string, v: string | boolean) => setValues((p) => ({ ...p, [key]: v }));

  const steps = fields ? [...new Set(fields.map((f) => f.step))].sort((a, b) => a - b) : [];
  const total = steps.length + 1; // field steps + review
  const onReview = fields !== null && idx === steps.length;
  const onDoneStep = fields !== null && idx === steps.length + 1;
  const stepFields = (s: number) => (fields ?? []).filter((f) => f.step === s);

  const filled = (f: FormField): boolean => {
    const v = values[f.key];
    // A required select with no available options (e.g. warehouse with no warehouses
    // configured) can't be filled — don't let it dead-lock the wizard.
    if (f.type === 'select' && optionsFor(f).length === 0) return true;
    if (f.type === 'checkbox') return v === true;
    if (f.type === 'number') return Number(v) > 0;
    return String(v ?? '').trim().length > 0;
  };
  const missingRequired = stepFields(steps[idx] ?? -1).filter((f) => f.required && !filled(f));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: CreateRequestData = { items: [] };
      const custom: Record<string, unknown> = {};
      let itemName = '';
      let quantity = 0;
      let unit: string | undefined;
      let firstText = '';
      for (const f of fields ?? []) {
        const v = values[f.key];
        const sval = typeof v === 'string' ? v.trim() : '';
        if (f.system) {
          switch (f.key) {
            case 'requestType': if (v) payload.requestType = String(v); break;
            case 'warehouse': if (v) payload.warehouseName = String(v); break;
            case 'priority': if (v) payload.priority = String(v); break;
            case 'itemName': itemName = sval; break;
            case 'quantity': quantity = Number(v) || 0; break;
            case 'unit': if (v) unit = String(v); break;
            case 'neededDate': payload.neededDate = v ? String(v) : null; break;
            case 'note': if (sval) payload.description = sval; break;
          }
        } else if (v !== '' && v !== false && v != null) {
          custom[f.key] = v;
        }
        if (!firstText && (f.type === 'text' || f.type === 'textarea') && sval) firstText = sval;
      }
      // Title falls back to the first text field so a fully-custom form (no item name)
      // still produces a readable request. Items are optional — build one only if named.
      const title = itemName || firstText;
      if (title) payload.title = title;
      payload.items = itemName ? [{ name: itemName, quantity: quantity || 1, unitPrice: 0, unit }] : [];
      if (Object.keys(custom).length) payload.customFields = custom;
      const res = await api.createRequest(payload);
      setSubmittedNo(res.requestNumber ?? '—');
      setIdx(steps.length + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel: CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 10 };
  const input: CSSProperties = { width: '100%', padding: '14px 16px', fontSize: 15, fontWeight: 500, border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" };
  const chip = (on: boolean): CSSProperties => ({ padding: '9px 14px', borderRadius: 10, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-bg)' : 'var(--card)', color: on ? 'var(--accent)' : 'var(--fg2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' });

  const displayValue = (f: FormField): string => {
    const v = values[f.key];
    if (f.type === 'checkbox') return v === true ? 'Да' : 'Нет';
    if (f.type === 'select') return optionsFor(f).find((o) => o.value === v)?.label ?? '—';
    return String(v ?? '').trim() || '—';
  };

  const renderField = (f: FormField) => {
    const optional = !f.required ? (
      <span style={{ fontWeight: 400, color: 'var(--fg3)' }}> (необязательно)</span>
    ) : showErrors && !filled(f) ? (
      <span style={{ fontWeight: 600, color: 'var(--danger)' }}> — заполните</span>
    ) : null;
    if (f.type === 'select') {
      const opts = optionsFor(f);
      if (f.key === 'warehouse' && opts.length === 0) {
        return (
          <div>
            <div style={fieldLabel}>{f.label}{optional}</div>
            <div style={{ fontSize: 13, color: 'var(--fg3)', padding: '6px 0', lineHeight: 1.45 }}>
              Склады ещё не настроены. Добавьте их в админке → «Структура».
            </div>
          </div>
        );
      }
      // Long lists become a compact dropdown instead of dozens of chips.
      if (opts.length > 8) {
        return (
          <div>
            <div style={fieldLabel}>{f.label}{optional}</div>
            <div style={{ position: 'relative' }}>
              <select
                value={String(values[f.key] ?? '')}
                onChange={(e) => set(f.key, e.target.value)}
                style={{ ...input, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', paddingRight: 38, cursor: 'pointer' }}
              >
                {!f.required && <option value="">— выберите —</option>}
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {o.meta ? ` · ${o.meta}` : ''}
                  </option>
                ))}
              </select>
              <span style={{ position: 'absolute', right: 14, top: '50%', marginTop: -8, pointerEvents: 'none', color: 'var(--fg3)', display: 'inline-block', transform: 'rotate(90deg)' }}>
                <Icon name="chev" size={16} sw={2.2} />
              </span>
            </div>
          </div>
        );
      }
      const hasMeta = opts.some((o) => o.meta);
      if (hasMeta) {
        return (
          <div>
            <div style={fieldLabel}>{f.label}{optional}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {opts.map((o) => {
                const on = values[f.key] === o.value;
                return (
                  <button key={o.value} onClick={() => set(f.key, on && !f.required ? '' : o.value)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 11, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-bg)' : 'var(--card)', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ width: 11, height: 11, borderRadius: '50%', flex: 'none', background: on ? 'var(--accent)' : 'var(--fg3)' }} />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: on ? 'var(--accent)' : 'var(--fg)' }}>{o.label}</span>
                    {o.meta && <span style={{ fontSize: 12, color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace" }}>{o.meta}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      }
      return (
        <div>
          <div style={fieldLabel}>{f.label}{optional}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {opts.map((o) => {
              const on = values[f.key] === o.value;
              return (
                <button key={o.value} onClick={() => set(f.key, on && !f.required ? '' : o.value)} style={{ ...chip(on), flex: 'none' }}>{o.label}</button>
              );
            })}
          </div>
        </div>
      );
    }
    if (f.type === 'textarea') {
      return (
        <div>
          <label style={fieldLabel}>{f.label}{optional}</label>
          <textarea value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder ?? ''} rows={3} style={{ ...input, resize: 'none', lineHeight: 1.45 }} />
        </div>
      );
    }
    if (f.type === 'checkbox') {
      const on = values[f.key] === true;
      return (
        <button onClick={() => set(f.key, !on)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? 'var(--accent)' : 'var(--card2)', border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: '#fff' }}>{on ? <Icon name="check" size={14} sw={3} /> : null}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{f.label}</span>
        </button>
      );
    }
    if (f.type === 'file') {
      return (
        <div>
          <label style={fieldLabel}>{f.label}{optional}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, borderRadius: 12, border: '1.5px dashed var(--border)', background: 'var(--card)', opacity: 0.75 }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-bg)', color: 'var(--accent)' }}><Icon name="camera" size={20} /></span>
            <div style={{ fontSize: 12.5, color: 'var(--fg3)' }}>Загрузка файлов появится позже.</div>
          </div>
        </div>
      );
    }
    return (
      <div>
        <label style={fieldLabel}>{f.label}{optional}</label>
        <input
          value={String(values[f.key] ?? '')}
          onChange={(e) => set(f.key, e.target.value)}
          type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
          placeholder={f.placeholder ?? ''}
          style={f.type === 'number' ? { ...input, fontFamily: "'IBM Plex Mono', monospace", fontSize: 16, fontWeight: 600 } : input}
        />
      </div>
    );
  };

  if (error && !fields) return <div style={{ padding: 18 }}><Err>{error}</Err></div>;
  if (!fields) return <div style={{ padding: 18 }}><Skeleton /></div>;
  if (fields.length === 0)
    return (
      <div style={{ padding: 18 }}>
        <div style={{ background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 14, padding: '24px 16px', textAlign: 'center', fontSize: 13.5, color: 'var(--fg2)', lineHeight: 1.5 }}>
          Форма создания заявки ещё не настроена. Добавьте поля в админке → «Форма заявки».
        </div>
      </div>
    );

  const stepTitle = onReview ? 'Проверьте заявку' : onDoneStep ? 'Готово' : `Шаг ${idx + 1}`;

  return (
    <div style={{ padding: '18px 20px 28px' }}>
      {!onDoneStep && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 13 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>{stepTitle}</span>
            <span style={{ fontSize: 12, color: 'var(--fg2)', fontFamily: "'IBM Plex Mono', monospace" }}>Шаг {idx + 1} из {total}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
            {Array.from({ length: total }, (_, n) => (
              <span key={n} style={{ flex: 1, height: 5, borderRadius: 3, background: n <= idx ? 'var(--accent)' : 'var(--chip)' }} />
            ))}
          </div>
        </>
      )}

      {!onReview && !onDoneStep && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {stepFields(steps[idx]).map((f) => (
            <div key={f.key}>{renderField(f)}</div>
          ))}
        </div>
      )}

      {onReview && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', overflow: 'hidden' }}>
          {fields.map((f) => (
            <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderTop: '1px solid var(--line)', gap: 12 }}>
              <span style={{ fontSize: 13, color: 'var(--fg2)' }}>{f.label}</span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', textAlign: 'right' }}>{displayValue(f)}</span>
            </div>
          ))}
        </div>
      )}

      {onDoneStep && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '34px 8px 8px' }}>
          <span style={{ width: 84, height: 84, borderRadius: '50%', background: 'var(--success)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={40} sw={2.4} />
          </span>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>Заявка отправлена</div>
          <div style={{ fontSize: 14, color: 'var(--fg2)', marginTop: 6, maxWidth: 270, lineHeight: 1.5 }}>Заявка передана в обработку. Вы получите уведомление на каждом этапе.</div>
          <div style={{ marginTop: 22, padding: '16px 22px', borderRadius: 14, background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: 'var(--fg)' }}>{submittedNo}</span>
            <StatusPill status="pending_approval" />
          </div>
        </div>
      )}

      {error && <Err>{error}</Err>}

      {!onReview && !onDoneStep && showErrors && missingRequired.length > 0 && (
        <div style={{ marginTop: 16, borderRadius: 12, background: 'var(--danger-bg)', color: 'var(--danger)', padding: '12px 14px', fontSize: 13, lineHeight: 1.45 }}>
          Заполните обязательные поля: {missingRequired.map((f) => f.label).join(', ')}.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 18 }}>
        {idx === 0 && !onDoneStep && (
          <button onClick={onDone} style={{ flex: '0 0 auto', padding: '15px 22px', borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Отмена</button>
        )}
        {idx > 0 && !onDoneStep && (
          <button onClick={() => { setShowErrors(false); setIdx((i) => i - 1); }} style={{ flex: '0 0 auto', padding: '15px 22px', borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Назад</button>
        )}
        {!onReview && !onDoneStep && (
          <button
            onClick={() => {
              if (missingRequired.length === 0) {
                setShowErrors(false);
                setIdx((i) => i + 1);
              } else {
                setShowErrors(true);
              }
            }}
            style={{ flex: 1, padding: 15, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}
          >
            Далее
          </button>
        )}
        {onReview && (
          <button onClick={submit} disabled={saving} style={{ flex: 1, padding: 15, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}>{saving ? '…' : 'Создать заявку'}</button>
        )}
        {onDoneStep && (
          <button onClick={onDone} style={{ flex: 1, padding: 15, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Готово</button>
        )}
      </div>
    </div>
  );
}

function actionBtnStyle(action: string): CSSProperties {
  const base: CSSProperties = { flex: 1, minWidth: 130, padding: 14, borderRadius: 12, border: 'none', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
  if (action === 'approve') return { ...base, background: 'var(--success)', color: '#fff', boxShadow: '0 8px 18px -8px var(--success)' };
  if (action === 'reject') return { ...base, background: 'var(--danger-bg)', color: 'var(--danger)' };
  return { ...base, background: 'var(--accent)', color: '#fff', boxShadow: '0 8px 18px -8px var(--accent)' };
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const dmy = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (sameDay(d, now)) return `Сегодня · ${dmy}`;
  if (sameDay(d, y)) return `Вчера · ${dmy}`;
  return dmy;
}
/** Group rows into consecutive same-day buckets (rows arrive newest-first from the API). */
function groupByDay(rows: RequestRow[]): { key: string; label: string; items: RequestRow[] }[] {
  const groups: { key: string; label: string; items: RequestRow[] }[] = [];
  for (const r of rows) {
    const d = r.createdAt ? new Date(r.createdAt) : null;
    const key = d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(r);
    else groups.push({ key, label: r.createdAt ? dayLabel(r.createdAt) : 'Без даты', items: [r] });
  }
  return groups;
}
function DateDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px 0' }}>
      <span style={{ height: 1, flex: 1, background: 'var(--line)' }} />
      <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fg3)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ height: 1, flex: 1, background: 'var(--line)' }} />
    </div>
  );
}

function RequestDetailView({ id, onBack }: { id: string; me: Me; onBack: () => void }) {
  const [req, setReq] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<LifecycleActionBtn | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getRequest(id).then(setReq).catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load]);

  const run = async (
    action: string,
    vals: { pin?: string; comment?: string; amount?: number; supplierName?: string; leadTime?: string; quotationId?: string } = {},
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.requestAction(id, { action, ...vals });
      setPending(null);
      load();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const onAction = (a: LifecycleActionBtn) => {
    if (a.pin || a.comment || a.amount || a.quote) setPending(a);
    else run(a.action).catch(() => {});
  };

  if (error && !req) return <div style={{ padding: 16 }}><Err>{error}</Err></div>;
  if (!req) return <div style={{ padding: 16 }}><Skeleton /></div>;

  const actions = req.actions ?? [];
  const history = req.statusHistory ?? [];
  const quotations = req.quotations ?? [];
  const info = [
    { k: 'Статус', v: req.statusLabel ?? statusMeta(req.status).label },
    { k: 'Позиций', v: String(req.items.length) },
  ];

  return (
    <div style={{ padding: '16px 16px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button onClick={onBack} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--fg2)', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
        ← Назад
      </button>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--fg2)', fontWeight: 500 }}>{req.requestNumber}</span>
          <StatusPill status={req.status} />
        </div>
        <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--fg)', marginTop: 8, letterSpacing: '-.01em' }}>{req.title || 'Без названия'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '13px 12px', marginTop: 16 }}>
          {info.map((i) => (
            <div key={i.k}>
              <div style={{ fontSize: 11, color: 'var(--fg3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>{i.k}</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', marginTop: 3 }}>{i.v}</div>
            </div>
          ))}
        </div>
      </div>

      {req.items.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Позиции</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {req.items.map((it) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <span style={{ fontSize: 14, color: 'var(--fg)' }}>
                  {it.name} <span style={{ color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace" }}>× {it.quantity}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {quotations.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Коммерческие предложения</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {quotations.map((q) => (
              <div key={q.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderRadius: 11, border: `1.5px solid ${q.selected ? 'var(--success)' : 'var(--line)'}`, background: q.selected ? 'var(--success-bg)' : 'var(--card2)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {q.supplierName}
                    {q.selected && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--success)' }}>✓ выбран</span>}
                  </div>
                  {q.leadTime && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>срок: {q.leadTime}</div>}
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700, color: 'var(--fg)', flex: 'none' }}>{q.amount.toLocaleString('ru-RU')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>История статусов</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {history.map((h, idx) => {
              const m = statusMeta(h.newStatus);
              const last = idx === history.length - 1;
              return (
                <div key={h.id} style={{ display: 'flex', gap: 13 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
                    <span style={{ width: 12, height: 12, borderRadius: '50%', marginTop: 4, flex: 'none', background: m.color }} />
                    {!last && <span style={{ width: 2, flex: 1, minHeight: 18, background: 'var(--line)' }} />}
                  </div>
                  <div style={{ paddingBottom: 14, paddingTop: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>{m.label}</div>
                    {h.comment && <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>{h.comment}</div>}
                    <div style={{ fontSize: 11, color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>{fmtDate(h.createdAt)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && <Err>{error}</Err>}

      {actions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {actions.map((a) => (
            <button key={a.action} onClick={() => onAction(a)} disabled={busy} style={{ ...actionBtnStyle(a.action), opacity: busy ? 0.5 : 1 }}>
              {a.label}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <ActionModal
          action={pending}
          busy={busy}
          error={error}
          quotations={quotations}
          onCancel={() => { setPending(null); setError(null); }}
          onConfirm={(vals) => run(pending.action, vals).catch(() => {})}
        />
      )}
    </div>
  );
}

function ActionModal({
  action,
  busy,
  error,
  quotations,
  onCancel,
  onConfirm,
}: {
  action: LifecycleActionBtn;
  busy: boolean;
  error: string | null;
  quotations: QuotationRow[];
  onCancel: () => void;
  onConfirm: (vals: { pin?: string; comment?: string; amount?: number; supplierName?: string; leadTime?: string; quotationId?: string }) => void;
}) {
  const [pin, setPin] = useState('');
  const [comment, setComment] = useState('');
  const [amount, setAmount] = useState('');
  const [supplier, setSupplier] = useState('');
  const [leadTime, setLeadTime] = useState('');
  const [quotationId, setQuotationId] = useState(quotations.find((q) => q.selected)?.id ?? '');
  const isAdd = action.quote === 'add';
  const isSelect = action.quote === 'select';
  const inputStyle: CSSProperties = { width: '100%', padding: '13px 15px', fontSize: 15, border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" };
  const lbl: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 8 };
  const ok =
    (!action.pin || pin.length >= 4) &&
    (!action.comment || comment.trim().length > 0) &&
    (!action.amount || (amount !== '' && Number(amount) >= 0)) &&
    (!isAdd || (supplier.trim().length > 0 && amount !== '' && Number(amount) > 0)) &&
    (!isSelect || quotationId !== '');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={onCancel} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>{action.label}</div>
        {isAdd && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>Поставщик</div>
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="напр. ООО «Метизы»" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>Сумма КП (UZS)</div>
              <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="0" style={{ ...inputStyle, fontFamily: "'IBM Plex Mono', monospace" }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>Срок поставки (необязательно)</div>
              <input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} placeholder="напр. 10 дней" style={inputStyle} />
            </div>
          </>
        )}
        {isSelect && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Выберите КП поставщика</div>
            {quotations.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--fg3)', padding: '8px 0' }}>Сначала добавьте хотя бы одно КП.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {quotations.map((q) => {
                  const sel = quotationId === q.id;
                  return (
                    <button key={q.id} onClick={() => setQuotationId(q.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 13px', borderRadius: 11, border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--border)'}`, background: sel ? 'var(--accent-bg)' : 'var(--card)', cursor: 'pointer', textAlign: 'left' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{q.supplierName}</div>
                        {q.leadTime && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>срок: {q.leadTime}</div>}
                      </div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700, color: sel ? 'var(--accent)' : 'var(--fg)', flex: 'none' }}>{q.amount.toLocaleString('ru-RU')}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {action.amount && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Сумма КП (UZS)</div>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="0" style={{ ...inputStyle, fontFamily: "'IBM Plex Mono', monospace" }} />
          </div>
        )}
        {action.comment && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Комментарий</div>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Причина / комментарий" style={{ ...inputStyle, resize: 'none', lineHeight: 1.45 }} />
          </div>
        )}
        {action.pin && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>PIN-код</div>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" type="password" placeholder="••••" style={{ ...inputStyle, letterSpacing: 6, textAlign: 'center' }} />
          </div>
        )}
        {error && <Err>{error}</Err>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Отмена</button>
          <button
            onClick={() =>
              onConfirm({
                pin: action.pin ? pin : undefined,
                comment: action.comment ? comment : undefined,
                amount: action.amount || isAdd ? Number(amount) : undefined,
                supplierName: isAdd ? supplier.trim() : undefined,
                leadTime: isAdd && leadTime.trim() ? leadTime.trim() : undefined,
                quotationId: isSelect ? quotationId : undefined,
              })
            }
            disabled={busy || !ok}
            style={{ flex: 1, padding: 14, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: busy || !ok ? 'not-allowed' : 'pointer', opacity: busy || !ok ? 0.5 : 1 }}
          >
            {busy ? '…' : 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small UI bits ────────────────────────────────────────────────────────────
function DevLogin({ error, onLoggedIn }: { error: string | null; onLoggedIn: () => void }) {
  const [tgId, setTgId] = useState('');
  const [err, setErr] = useState<string | null>(error);

  const login = async () => {
    setErr(null);
    try {
      const r = await api.loginDev(tgId.trim());
      setToken(r.token);
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Centered>
      <div className="w-full max-w-xs">
        <div className="mb-1 text-center text-2xl font-bold tracking-tight text-fg">⚙️ Factory OS</div>
        <p className="mb-5 text-center text-xs leading-relaxed text-fg3">
          Откройте внутри Telegram для обычного входа. Локально — dev-вход по Telegram ID.
        </p>
        <input
          value={tgId}
          onChange={(e) => setTgId(e.target.value)}
          placeholder="Ваш Telegram ID"
          className="mb-2.5 w-full rounded-xl border border-line bg-card px-3.5 py-3 text-center font-mono text-sm text-fg outline-none placeholder:text-fg3 focus:border-accent"
        />
        <button
          onClick={login}
          className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white shadow-lg shadow-accent/20 active:scale-95"
        >
          Войти (dev)
        </button>
        {err && <Err>{err}</Err>}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-6 text-fg2">{children}</div>;
}
function statusMeta(status: string): { label: string; color: string; bg: string } {
  switch (status) {
    case 'warehouse_check':
      return { label: 'Проверка склада', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'in_stock':
      return { label: 'В наличии', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'partially_available':
      return { label: 'Частично в наличии', color: 'var(--warning)', bg: 'var(--warning-bg)' };
    case 'out_of_stock':
      return { label: 'Нет в наличии', color: 'var(--danger)', bg: 'var(--danger-bg)' };
    case 'procurement':
      return { label: 'В закупке', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'quotation_received':
      return { label: 'Получены КП', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'approval_pending':
    case 'pending_approval':
      return { label: 'На согласовании', color: 'var(--warning)', bg: 'var(--warning-bg)' };
    case 'approved':
      return { label: 'Согласована', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'rejected':
      return { label: 'Отклонена', color: 'var(--danger)', bg: 'var(--danger-bg)' };
    case 'paid':
      return { label: 'Оплачена', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'in_delivery':
      return { label: 'В доставке', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'warehouse_receiving':
      return { label: 'Приёмка на складе', color: 'var(--accent)', bg: 'var(--accent-bg)' };
    case 'accepted_to_warehouse':
      return { label: 'Принята на склад', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'issued':
      return { label: 'Выдана в отдел', color: 'var(--success)', bg: 'var(--success-bg)' };
    case 'closed':
      return { label: 'Закрыта', color: 'var(--fg3)', bg: 'var(--chip)' };
    case 'draft':
      return { label: 'Черновик', color: 'var(--fg3)', bg: 'var(--chip)' };
    default:
      return { label: status, color: 'var(--fg2)', bg: 'var(--chip)' };
  }
}

function progressOf(status: string): string {
  switch (status) {
    case 'draft':
      return '8%';
    case 'warehouse_check':
      return '20%';
    case 'in_stock':
    case 'partially_available':
    case 'out_of_stock':
      return '40%';
    case 'procurement':
    case 'quotation_received':
      return '60%';
    case 'approval_pending':
    case 'pending_approval':
      return '80%';
    case 'approved':
      return '84%';
    case 'paid':
      return '88%';
    case 'in_delivery':
      return '91%';
    case 'warehouse_receiving':
      return '94%';
    case 'accepted_to_warehouse':
      return '96%';
    case 'issued':
      return '98%';
    case 'closed':
    case 'rejected':
      return '100%';
    default:
      return '30%';
  }
}

function StatusPill({ status }: { status: string }) {
  const s = statusMeta(status);
  return (
    <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, background: s.bg, color: s.color, fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color }} />
      {s.label}
    </span>
  );
}
function Err({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-xl bg-danger/15 px-3 py-2.5 text-sm text-danger">{children}</div>;
}
function Note({ children }: { children: ReactNode }) {
  return <div className="mb-4 rounded-xl bg-warning/15 px-3 py-2.5 text-sm text-warning">{children}</div>;
}
function Skeleton() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[68px] animate-pulse rounded-2xl bg-card" />
      ))}
    </div>
  );
}
