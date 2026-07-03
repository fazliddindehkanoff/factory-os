import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, clearToken, getToken, setToken, getTestUser, setTestUser, type CreateRequestData } from './api';
import { getTelegram, confirmDialog } from './telegram';
import { AdminPanel } from './admin/AdminPanel';
import { WarehouseScreen } from './screens/Warehouse';
import { InboxScreen } from './screens/Inbox';
import { ProcurementScreen } from './screens/Procurement';
import { Icon, TINT_BG, TINT_FG } from './icons';
import { applyTheme, getTheme, type Theme } from './theme';
import { DASHBOARD_ACTIONS } from './dashboard.config';
// Single source of truth for status labels/progress (covers every workflow-driven
// status incl. finance_payment/delivery/receiving/issue) — see screens/shared.tsx.
import { statusMeta, progressOf } from './screens/shared';

const ADMIN_PERMS = ['roles.manage', 'users.manage', 'workflows.manage', 'settings.manage'];
// Perms that let a user act on a request somewhere in the lifecycle → they get the inbox tab.
const INBOX_ACTOR_PERMS = [
  'approvals.approve',
  'warehouse.check_stock',
  'warehouse.receive',
  'warehouse.issue',
  'procurement.quote',
  'procurement.select_supplier',
  'finance.mark_paid',
];

// ── Types ────────────────────────────────────────────────────────────────────
interface Me {
  user: { id: string; fullName: string; holdingId: string | null; roleName?: string | null };
  permissions: string[];
}
interface RequestRow {
  id: string;
  requestNumber: string;
  status: string;
  estimatedAmount: number;
  title: string | null;
  createdAt: string;
  requesterId?: string;
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
  assign?: boolean;
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
  changedByName?: string | null;
  changedByRole?: string | null;
}
interface WorkflowTimelineStep {
  stepId?: string;
  stepName: string;
  stepKind: string;
  state: 'completed' | 'current' | 'future' | 'rejected';
  actorName?: string | null;
  actorRole?: string | null;
  at?: string | null;
  action?: string | null;
}
interface RequestDetail extends RequestRow {
  items: { id: string; name: string; quantity: string; unit?: string | null; estimatedPrice?: number | null; totalAmount: number | null }[];
  approvals: ApprovalRow[];
  statusLabel?: string;
  statusHistory?: StatusHistoryRow[];
  quotations?: QuotationRow[];
  actions?: LifecycleActionBtn[];
  workflowTimeline?: WorkflowTimelineStep[];
  canSeeMoney?: boolean;
  // full-info fields (bug #9)
  requesterName?: string | null;
  responsibleName?: string | null;
  factoryName?: string | null;
  departmentNameResolved?: string | null;
  departmentName?: string | null;
  warehouseName?: string | null;
  priority?: string | null;
  requestType?: string | null;
  neededDate?: string | null;
  description?: string | null;
  customFields?: Record<string, unknown> | null;
  updatedAt?: string | null;
  currency?: string | null;
}
type Screen =
  | { name: 'home' }
  // `status` — optional prefilter applied when the list opens (KPI/by-status click).
  | { name: 'list'; status?: string }
  | { name: 'create' }
  // `from` — the screen that opened the detail, so "back" returns to the source.
  | { name: 'detail'; id: string; from?: 'home' | 'list' | 'approvals' | 'procurement' | 'notifications' }
  | { name: 'approvals' }
  | { name: 'warehouse' }
  | { name: 'procurement' }
  | { name: 'notifications' }
  | { name: 'menu' }
  | { name: 'admin' };

interface DashboardData {
  myActive: number;
  pendingForMe: number;
  totalActive: number;
  activity: { id: string; requestNumber: string; status: string; title: string | null }[];
  // Sprint 1 additive aggregates. null = no permission → card hidden.
  awaitingPayment: number | null;
  inProcurement: number | null;
  lowStock: number | null;
  byStatus: Record<string, number> | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const money = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0);

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
  const [unread, setUnread] = useState<number>(0);
  // Test mode: the seeded test users for the DEV role-switcher. Stays null in
  // production — /api/dev/users answers 404 there, so no panel is ever rendered.
  const [devUsers, setDevUsers] = useState<DevUser[] | null>(null);
  const [devPin, setDevPin] = useState('');
  useEffect(() => {
    api.devUsers().then((r) => { setDevUsers(r.users); setDevPin(r.pin); }).catch(() => {});
  }, []);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Header bell badge — unread notification count (best-effort; failure keeps 0).
  const refreshUnread = useCallback(() => {
    api.notificationsUnreadCount().then((r: any) => setUnread(r?.unread ?? 0)).catch(() => {});
  }, []);
  useEffect(() => { if (me) refreshUnread(); }, [me, refreshUnread]);

  // Bug #6: silent auto-refresh every 30s so new data appears without a manual
  // reload. Screens include `tick` in their fetch deps; refreshes are silent (no
  // skeleton flash) and forms/modals keep their own state, so nothing is lost.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!me) return;
    const t = setInterval(() => { setTick((x) => x + 1); refreshUnread(); }, 30000);
    return () => clearInterval(t);
  }, [me, refreshUnread]);

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
        // Test mode (docs/TEST_MODE.md): `?user=sklad_01` pins THIS WINDOW to a test
        // user — the token lives in sessionStorage, so several windows can run
        // different roles side by side. Dev auth is stealth-404 in production, so a
        // stray ?user= there simply falls through to the normal login paths.
        const urlUser = new URLSearchParams(window.location.search).get('user')?.trim();
        if (urlUser && urlUser !== getTestUser()) {
          const r = await api.loginDev(urlUser);
          setToken(r.token, { perWindow: true });
          setTestUser(urlUser);
          await loadMe();
        } else if (getToken()) await loadMe();
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
        testUsers={devUsers}
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
    procurement: 'Закупки',
    notifications: 'Уведомления',
    menu: 'Меню',
    admin: 'Администрирование',
  };
  const title = TITLES[screen.name];
  const fullBleed = ['home', 'list', 'detail', 'create', 'approvals', 'warehouse', 'notifications'].includes(screen.name);
  const showNav = ['home', 'list', 'approvals', 'warehouse', 'procurement', 'notifications', 'menu', 'admin'].includes(screen.name);
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
            <button aria-label="Уведомления" onClick={() => setScreen({ name: 'notifications' })} style={{ ...iconBtn, position: 'relative' }}>
              <Icon name="bell" size={20} />
              {unread > 0 && (
                <span
                  aria-label={`${unread} непрочитанных`}
                  style={{ position: 'absolute', top: -3, right: -3, minWidth: 17, height: 17, padding: '0 4px', borderRadius: 9, background: 'var(--danger)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '17px', textAlign: 'center', boxShadow: '0 0 0 2px var(--header)' }}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
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
            <Note>Вы не привязаны к организации. Попросите администратора назначить вам права.</Note>
          </div>
        )}
        {screen.name === 'home' && (
          <Home me={me} tick={tick} onNav={setScreen} onOpen={(id) => setScreen({ name: 'detail', id, from: 'home' })} />
        )}
        {screen.name === 'list' && (
          <RequestsList
            me={me}
            tick={tick}
            initialStatus={screen.status}
            onCreate={() => setScreen({ name: 'create' })}
            onOpen={(id) => setScreen({ name: 'detail', id, from: 'list' })}
          />
        )}
        {screen.name === 'create' && <CreateRequest onDone={() => setScreen({ name: 'list' })} />}
        {screen.name === 'detail' && (
          <RequestDetailView id={screen.id} me={me} tick={tick} onBack={() => setScreen({ name: screen.from ?? 'list' } as Screen)} />
        )}
        {screen.name === 'approvals' && <InboxScreen onOpen={(id) => setScreen({ name: 'detail', id, from: 'approvals' })} permissions={me.permissions} />}
        {screen.name === 'warehouse' && <WarehouseScreen permissions={me.permissions} />}
        {screen.name === 'procurement' && (
          <ProcurementScreen canManage={me.permissions.includes('suppliers.manage')} onOpen={(id) => setScreen({ name: 'detail', id, from: 'procurement' })} />
        )}
        {screen.name === 'notifications' && (
          <NotificationsScreen
            onOpenRequest={(id) => setScreen({ name: 'detail', id, from: 'notifications' })}
            onChanged={refreshUnread}
          />
        )}
        {screen.name === 'menu' && <Menu me={me} theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} onLogout={() => { clearToken(); setMe(null); }} onProfileUpdated={loadMe} />}
        {screen.name === 'admin' && (
          <AdminPanel permissions={me.permissions} onExit={() => setScreen({ name: 'home' })} />
        )}
      </main>

      {showNav && <BottomNav me={me} active={screen.name} onNav={setScreen} />}
      {devUsers && devUsers.length > 0 && <DevSwitcher users={devUsers} pin={devPin} current={getTestUser()} />}
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
  // Independent tabs: warehouse/procurement show by their own permission,
  // in parallel with the admin tab (an else-if chain hid them from combined roles).
  if (isAdmin) tabs.push({ key: 'admin', label: 'Админ', ic: 'shield' });
  if (can('warehouse.view')) tabs.push({ key: 'warehouse', label: 'Склад', ic: 'box' });
  if (can('procurement.view')) tabs.push({ key: 'procurement', label: 'Закупки', ic: 'box' });
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

function Menu({ me, theme, onToggleTheme, onLogout, onProfileUpdated }: { me: Me; theme: Theme; onToggleTheme: () => void; onLogout: () => void; onProfileUpdated: () => void }) {
  const rowStyle: CSSProperties = {
    width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: '14px 15px', border: 'none',
    borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left',
  };
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [pName, setPName] = useState(me.user.fullName);
  const [pPhone, setPPhone] = useState((me.user as any).phone ?? '');
  const [pEmail, setPEmail] = useState((me.user as any).email ?? '');
  const [pPosition, setPPosition] = useState((me.user as any).position ?? '');
  const [pSaving, setPSaving] = useState(false);
  const [pMsg, setPMsg] = useState<string | null>(null);
  const saveProfile = async () => {
    setPSaving(true); setPMsg(null);
    try {
      await api.updateProfile({ fullName: pName.trim(), phone: pPhone.trim(), email: pEmail.trim(), position: pPosition.trim() });
      setPMsg('Сохранено');
      onProfileUpdated();
    } catch (e) { setPMsg((e as Error).message); }
    finally { setPSaving(false); }
  };
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
          <div style={{ fontSize: 12.5, color: 'var(--fg2)' }}>{roleLabel(me.permissions, me.user.roleName)} · {me.permissions.length} прав</div>
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
        <button onClick={() => { setProfileOpen(true); setPMsg(null); }} style={{ ...rowStyle, borderTop: 'none' }}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="gear" size={19} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Редактировать профиль</span>
          <span style={{ color: 'var(--fg3)' }}><Icon name="chev" size={16} sw={2.2} /></span>
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

      {profileOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={() => setProfileOpen(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
          <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>Редактировать профиль</div>
            {[
              { label: 'Имя', value: pName, set: setPName, ph: 'Ваше имя' },
              { label: 'Телефон', value: pPhone, set: setPPhone, ph: '+998 90 123 45 67' },
              { label: 'Email', value: pEmail, set: setPEmail, ph: 'email@example.com' },
              { label: 'Должность', value: pPosition, set: setPPosition, ph: 'напр. Инженер' },
            ].map((f) => (
              <div key={f.label} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 6 }}>{f.label}</div>
                <input value={f.value} onChange={(e) => f.set(e.target.value)} placeholder={f.ph} style={{ width: '100%', padding: '12px 14px', fontSize: 14, border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none' }} />
              </div>
            ))}
            {pMsg && <div style={{ marginTop: 8, fontSize: 13, color: pMsg === 'Сохранено' ? 'var(--success)' : 'var(--danger)' }}>{pMsg}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setProfileOpen(false)} style={{ flex: 1, padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Закрыть</button>
              <button onClick={saveProfile} disabled={pSaving || !pName.trim()} style={{ flex: 1, padding: 14, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: pSaving || !pName.trim() ? 'not-allowed' : 'pointer', opacity: pSaving || !pName.trim() ? 0.5 : 1 }}>{pSaving ? '...' : 'Сохранить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Screens ──────────────────────────────────────────────────────────────────
function roleLabel(perms: string[], roleName?: string | null): string {
  if (roleName) return roleName;
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

// A compact request row shared by the recent-activity feed and the queue previews.
function RequestRowButton({ id, title, requestNumber, status, onOpen, first }: {
  id: string; title: string | null; requestNumber: string; status: string; onOpen: (id: string) => void; first: boolean;
}) {
  const t = actTint(status);
  return (
    <button
      onClick={() => onOpen(id)}
      style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 13, padding: '13px 15px', border: 'none', borderTop: first ? 'none' : '1px solid var(--line)', background: 'none', cursor: 'pointer' }}
    >
      <span style={{ width: 36, height: 36, flex: 'none', borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TINT_BG[t.tint], color: TINT_FG[t.tint] }}>
        <Icon name={t.ic} size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || requestNumber}</div>
        <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>{statusMeta(status).label} · {requestNumber}</div>
      </div>
    </button>
  );
}

type QueueItem = { id: string; title: string | null; requestNumber: string; status: string };
const normalizeReq = (x: any): QueueItem => ({ id: x.id, title: x.title ?? null, requestNumber: x.requestNumber ?? '', status: x.status ?? '' });
const pickItems = (res: any): QueueItem[] => (Array.isArray(res) ? res : res?.items ?? []).map(normalizeReq);

// Role-aware queue preview: fetches a list endpoint, shows top items with
// loading / empty / error states. Used for "My Approvals" and the profile queue.
function QueuePreview({ title, load, onOpen, onSeeAll, emptyText }: {
  title: string;
  load: () => Promise<QueueItem[]>;
  onOpen: (id: string) => void;
  onSeeAll?: () => void;
  emptyText: string;
}) {
  const [rows, setRows] = useState<QueueItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setRows(null); setErr(null);
    load().then((r) => { if (alive) setRows(r); }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);
  const top = rows ? rows.slice(0, 4) : [];
  return (
    <div style={{ padding: '22px 20px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ ...SECTION_LABEL, marginBottom: 0 }}>{title}{rows ? ` · ${rows.length}` : ''}</div>
        {onSeeAll && rows && rows.length > 0 && (
          <button onClick={onSeeAll} style={{ border: 'none', background: 'none', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>все →</button>
        )}
      </div>
      {!rows && !err && <div className="animate-pulse" style={{ height: 60, borderRadius: 14, background: 'var(--skel)' }} />}
      {err && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--danger)', borderRadius: 14, padding: '14px 16px', fontSize: 13, color: 'var(--danger)' }}>
          Не удалось загрузить: {err}
        </div>
      )}
      {rows && !err && rows.length === 0 && (
        <div style={{ background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 14, padding: '20px 16px', textAlign: 'center', fontSize: 13, color: 'var(--fg3)' }}>{emptyText}</div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', overflow: 'hidden' }}>
          {top.map((r, i) => <RequestRowButton key={r.id} {...r} onOpen={onOpen} first={i === 0} />)}
        </div>
      )}
    </div>
  );
}

interface KpiCard { key: string; label: string; value: number | null; tint: string; ic: string; onClick?: () => void; }

// ── Notification Center (P1-6 backend) ───────────────────────────────────────
interface NotifItem {
  id: string;
  title: string;
  message: string;
  priority: string;
  status: string; // pending | delivered (=unread) | read | failed
  errorMessage: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

const NOTIF_STATUS: Record<string, { label: string; tint: string }> = {
  delivered: { label: 'Непрочитано', tint: 'accent' },
  read: { label: 'Прочитано', tint: 'success' },
  failed: { label: 'Не доставлено', tint: 'danger' },
  pending: { label: 'Отправляется', tint: 'warning' },
};
// Priority accent — a coloured left rail for the ones that matter.
const NOTIF_PRIORITY_TINT: Record<string, string> = { critical: 'danger', urgent: 'danger', high: 'warning' };

function fmtDateTime(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function NotificationsScreen({ onOpenRequest, onChanged }: { onOpenRequest: (id: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<NotifItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(() => {
    setItems(null); setErr(null);
    api.notifications(filter === 'unread').then((r: any) => setItems(r?.items ?? [])).catch((e) => setErr((e as Error).message));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  // Only a delivered (unread) notification needs marking.
  const markRead = async (n: NotifItem) => {
    if (n.status !== 'delivered') return;
    try { await api.markNotificationRead(n.id); } catch { /* best-effort — must never block navigation */ }
    setItems((prev) => (prev ? prev.map((x) => (x.id === n.id ? { ...x, status: 'read', readAt: new Date().toISOString() } : x)) : prev));
    onChanged();
  };

  const onCardClick = async (n: NotifItem) => {
    // Auto mark-read, THEN navigate. Navigation happens even if mark-read failed (no fake success).
    await markRead(n);
    if (n.entityType === 'request' && n.entityId) onOpenRequest(n.entityId);
  };

  const markAll = async () => {
    setMarkingAll(true);
    try { await api.markAllNotificationsRead(); onChanged(); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setMarkingAll(false); }
  };

  // In the "unread" tab, drop items just marked read locally.
  const visible = items ? (filter === 'unread' ? items.filter((n) => n.status === 'delivered') : items) : null;
  const hasUnread = (items ?? []).some((n) => n.status === 'delivered');

  const pill = (active: boolean): CSSProperties => ({
    padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: active ? 'var(--accent)' : 'var(--card)', color: active ? '#fff' : 'var(--fg2)',
  });

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>Уведомления</span>
          <button
            onClick={markAll}
            disabled={markingAll || !hasUnread}
            style={{ padding: '7px 12px', borderRadius: 10, border: 'none', background: hasUnread ? 'var(--accent-bg)' : 'transparent', color: hasUnread ? 'var(--accent)' : 'var(--fg3)', fontSize: 12.5, fontWeight: 600, cursor: hasUnread ? 'pointer' : 'default' }}
          >
            Прочитать все
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setFilter('all')} style={pill(filter === 'all')}>Все</button>
          <button onClick={() => setFilter('unread')} style={pill(filter === 'unread')}>Непрочитанные</button>
        </div>
      </div>

      <div style={{ padding: '10px 16px 24px' }}>
        {!visible && !err && <div className="animate-pulse" style={{ height: 76, borderRadius: 14, background: 'var(--skel)' }} />}
        {err && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--danger)', borderRadius: 14, padding: '16px', fontSize: 13.5, color: 'var(--danger)' }}>
            Не удалось загрузить уведомления: {err}
          </div>
        )}
        {visible && !err && visible.length === 0 && (
          <div style={{ background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 14, padding: '32px 16px', textAlign: 'center', fontSize: 13.5, color: 'var(--fg3)' }}>
            {filter === 'unread' ? 'Непрочитанных уведомлений нет.' : 'Уведомлений пока нет.'}
          </div>
        )}
        {visible && visible.map((n) => {
          const st = NOTIF_STATUS[n.status] ?? { label: n.status, tint: 'accent' };
          const unreadRow = n.status === 'delivered';
          const railTint = NOTIF_PRIORITY_TINT[n.priority];
          return (
            <button
              key={n.id}
              onClick={() => onCardClick(n)}
              style={{
                width: '100%', textAlign: 'left', display: 'block', marginBottom: 10, cursor: 'pointer',
                background: 'var(--card)', border: '1px solid var(--border)',
                borderLeft: railTint ? `3px solid ${TINT_FG[railTint]}` : '1px solid var(--border)',
                borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: '13px 15px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                {unreadRow && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flex: 'none' }} />}
                <span style={{ flex: 1, fontSize: 14, fontWeight: unreadRow ? 700 : 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                <span style={{ flex: 'none', fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 8, background: TINT_BG[st.tint], color: TINT_FG[st.tint] }}>{st.label}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--fg2)', lineHeight: 1.4 }}>{n.message}</div>
              {n.status === 'failed' && n.errorMessage && (
                <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>Причина: {n.errorMessage}</div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11.5, color: 'var(--fg3)' }}>
                <span>{fmtDateTime(n.createdAt)}</span>
                {n.readAt && <span>· прочитано {fmtDateTime(n.readAt)}</span>}
                {n.entityType === 'request' && n.entityId && (
                  <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    К заявке <Icon name="chev" size={14} sw={2.2} />
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Home({
  me,
  onNav,
  onOpen,
  tick = 0,
}: {
  me: Me;
  onNav: (s: Screen) => void;
  onOpen: (id: string) => void;
  tick?: number;
}) {
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Silent refresh on tick: keep old data visible (no skeleton) until new arrives.
    api.dashboard().then((d) => { if (alive) { setDash(d); setErr(null); } }).catch((e) => { if (alive && !dash) setErr((e as Error).message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const can = (p: string) => me.permissions.includes(p);
  const oversight = can('reports.view') || can('audit.view');

  // KPI cards — permission-gated; the new aggregates are hidden unless the backend
  // returned a non-null value (permission-hiding driven by GET /dashboard).
  const cards: KpiCard[] = [];
  if (can('requests.view')) cards.push({ key: 'myActive', label: 'Мои заявки', value: dash?.myActive ?? null, tint: 'accent', ic: 'file', onClick: () => onNav({ name: 'list' }) });
  if (can('approvals.approve')) cards.push({ key: 'pending', label: 'Ожидают меня', value: dash?.pendingForMe ?? null, tint: 'warning', ic: 'checkCircle', onClick: () => onNav({ name: 'approvals' }) });
  if (oversight) cards.push({ key: 'total', label: 'Активных всего', value: dash?.totalActive ?? null, tint: 'success', ic: 'box', onClick: () => onNav({ name: 'list' }) });
  if (dash && dash.awaitingPayment != null) cards.push({ key: 'awaiting', label: 'Ожидают оплаты', value: dash.awaitingPayment, tint: 'warning', ic: 'wallet', onClick: () => onNav({ name: 'list', status: 'finance_payment' }) });
  if (dash && dash.inProcurement != null) cards.push({ key: 'proc', label: 'В закупке', value: dash.inProcurement, tint: 'accent', ic: 'truck', onClick: () => onNav({ name: 'list', status: 'procurement' }) });
  if (dash && dash.lowStock != null) cards.push({ key: 'low', label: 'Низкий остаток', value: dash.lowStock, tint: 'danger', ic: 'alert', onClick: () => onNav({ name: 'warehouse' }) });
  // Unread is shown via the header bell badge, not a dashboard card (per request).

  // by-status breakdown (oversight only) — chips deep-link to the filtered list.
  const byStatus = dash?.byStatus ?? null;
  const byStatusEntries = byStatus ? Object.entries(byStatus).sort((a, b) => b[1] - a[1]) : [];

  // Profile queue (one, by role) — only endpoints that exist as a single call.
  // NOTE: warehouse "receiving|issue" tasks need a multi-status list the API does
  // not expose (out of this sprint's backend scope), so warehouse users get a link
  // to the Warehouse screen instead of an inline list — not a silent single-status hack.
  const profileQueue: { title: string; load: () => Promise<QueueItem[]>; onSeeAll?: () => void; emptyText: string } | null =
    can('procurement.view')
      ? { title: 'Очередь снабжения', load: async () => pickItems(await api.procurement.queue()), onSeeAll: () => onNav({ name: 'procurement' }), emptyText: 'Нет заявок в закупке.' }
      : can('finance.view')
        ? { title: 'Ожидают оплаты', load: async () => pickItems(await api.listRequests({ status: 'finance_payment', limit: 8 })), onSeeAll: () => onNav({ name: 'list', status: 'finance_payment' }), emptyText: 'Нет заявок на оплату.' }
        : null;

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
          {roleLabel(me.permissions, me.user.roleName)}
        </div>
      </div>

      {/* Dashboard load error — surfaced, never a silent blank (audit fix) */}
      {err && (
        <div style={{ position: 'relative', marginTop: -32, padding: '0 20px' }}>
          <div style={{ background: 'var(--card)', border: '1px solid var(--danger)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: '16px', fontSize: 13.5, color: 'var(--danger)' }}>
            Не удалось загрузить дашборд: {err}
          </div>
        </div>
      )}

      {/* KPI cards — overlap up into the navy block */}
      {!err && cards.length > 0 && (
        <div style={{ position: 'relative', marginTop: -32 }}>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', padding: '0 20px 4px', scrollSnapType: 'x mandatory' }}>
            {cards.map((c) => {
              const inner = (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TINT_BG[c.tint], color: TINT_FG[c.tint] }}>
                      <Icon name={c.ic} size={19} />
                    </span>
                    {c.onClick && <span style={{ color: 'var(--fg3)' }}><Icon name="chev" size={17} sw={2.2} /></span>}
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 30, fontWeight: 600, lineHeight: 1, color: 'var(--fg)' }}>{c.value ?? '—'}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--fg2)', fontWeight: 500, lineHeight: 1.25 }}>{c.label}</div>
                </>
              );
              const base: CSSProperties = { scrollSnapAlign: 'start', flex: '0 0 auto', width: 166, textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: 9 };
              return c.onClick
                ? <button key={c.key} onClick={c.onClick} style={{ ...base, cursor: 'pointer' }}>{inner}</button>
                : <div key={c.key} style={base}>{inner}</div>;
            })}
          </div>
        </div>
      )}

      {/* Loading skeleton for KPI cards while the dashboard loads */}
      {!err && !dash && (
        <div style={{ position: 'relative', marginTop: -32, padding: '0 20px' }}>
          <div className="animate-pulse" style={{ height: 118, borderRadius: 14, background: 'var(--skel)' }} />
        </div>
      )}

      {/* Quick actions (New request / All requests / Admin) — role-gated */}
      {!err && (() => {
        const actions: { label: string; tint: string; ic: string; onClick: () => void }[] = [];
        for (const a of DASHBOARD_ACTIONS) if (can(a.perm)) actions.push({ label: a.label, tint: a.tint, ic: a.ic, onClick: () => onNav({ name: a.go }) });
        if (ADMIN_PERMS.some(can)) actions.push({ label: 'Администрирование', tint: 'accent', ic: 'gear', onClick: () => onNav({ name: 'admin' }) });
        return actions.length > 0 ? (
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
        ) : null;
      })()}

      {/* requests-by-status breakdown (oversight only) */}
      {!err && oversight && byStatusEntries.length > 0 && (
        <div style={{ padding: '24px 20px 0' }}>
          <div style={SECTION_LABEL}>Заявки по статусам</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {byStatusEntries.map(([st, n]) => {
              const m = statusMeta(st);
              return (
                <button
                  key={st}
                  onClick={() => onNav({ name: 'list', status: st })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--fg2)' }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
                  {m.label}
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: 'var(--fg)' }}>{n}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Queue slot 1 — My Approvals (role-aware) */}
      {!err && can('approvals.approve') && (
        <QueuePreview
          title="Ждут моего решения"
          load={async () => pickItems(await api.inbox())}
          onOpen={onOpen}
          onSeeAll={() => onNav({ name: 'approvals' })}
          emptyText="Нет заявок, ожидающих вашего решения."
        />
      )}

      {/* Queue slot 2 — profile queue (procurement / finance) */}
      {!err && profileQueue && (
        <QueuePreview title={profileQueue.title} load={profileQueue.load} onOpen={onOpen} onSeeAll={profileQueue.onSeeAll} emptyText={profileQueue.emptyText} />
      )}

      {/* Queue slot 2 (warehouse) — link to the Warehouse screen (multi-status list not in API) */}
      {!err && !profileQueue && can('warehouse.view') && (
        <div style={{ padding: '22px 20px 0' }}>
          <div style={SECTION_LABEL}>Склад</div>
          <button
            onClick={() => onNav({ name: 'warehouse' })}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 13, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: '15px', cursor: 'pointer', textAlign: 'left' }}
          >
            <span style={{ width: 40, height: 40, flex: 'none', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: TINT_BG.accent, color: TINT_FG.accent }}>
              <Icon name="box" size={21} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Приёмка и выдача</div>
              <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>Открыть склад: остатки, приёмка, выдача</div>
            </div>
            <span style={{ color: 'var(--fg3)' }}><Icon name="chev" size={18} sw={2.2} /></span>
          </button>
        </div>
      )}

      {/* Queue slot 3 — Recent activity (own for requester, holding for oversight) */}
      <div style={{ padding: '24px 20px 24px' }}>
        <div style={SECTION_LABEL}>Последние события</div>
        {!dash && !err && <div className="animate-pulse" style={{ height: 68, borderRadius: 14, background: 'var(--skel)' }} />}
        {dash && dash.activity.length === 0 && (
          <div style={{ background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 14, padding: '24px 16px', textAlign: 'center', fontSize: 13, color: 'var(--fg3)' }}>
            Пока нет событий — здесь появятся обновления по вашим заявкам.
          </div>
        )}
        {dash && dash.activity.length > 0 && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', overflow: 'hidden' }}>
            {dash.activity.map((e, idx) => (
              <RequestRowButton key={e.id} id={e.id} title={e.title} requestNumber={e.requestNumber} status={e.status} onOpen={onOpen} first={idx === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function MiniCalendar({ requestDates, selectedDate, onSelect }: {
  requestDates: Set<string>;
  selectedDate: string | null;
  onSelect: (date: string | null) => void;
}) {
  const [viewDate, setViewDate] = useState(() => new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0
  const daysInMonth = lastDay.getDate();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const cells: (number | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const prev = () => setViewDate(new Date(year, month - 1, 1));
  const next = () => setViewDate(new Date(year, month + 1, 1));

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '12px 10px 8px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, padding: '0 4px' }}>
        <button onClick={prev} style={{ border: 'none', background: 'none', color: 'var(--fg2)', cursor: 'pointer', fontSize: 18, padding: '2px 8px' }}>‹</button>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)' }}>{MONTH_NAMES[month]} {year}</span>
        <button onClick={next} style={{ border: 'none', background: 'none', color: 'var(--fg2)', cursor: 'pointer', fontSize: 18, padding: '2px 8px' }}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {WEEKDAYS.map((w) => (
          <span key={w} style={{ fontSize: 10, fontWeight: 600, color: 'var(--fg3)', padding: '4px 0' }}>{w}</span>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <span key={`e${i}`} />;
          const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const hasReq = requestDates.has(dateKey);
          const isSelected = selectedDate === dateKey;
          const isToday = dateKey === todayKey;
          return (
            <button
              key={dateKey}
              onClick={() => onSelect(isSelected ? null : dateKey)}
              style={{
                position: 'relative', border: 'none', borderRadius: 8, padding: '6px 0', fontSize: 12, fontWeight: isToday || isSelected ? 700 : 500, cursor: 'pointer',
                background: isSelected ? 'var(--accent)' : 'transparent',
                color: isSelected ? '#fff' : isToday ? 'var(--accent)' : 'var(--fg)',
              }}
            >
              {d}
              {hasReq && !isSelected && (
                <span style={{ position: 'absolute', bottom: 2, left: '50%', marginLeft: -2.5, width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)' }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RequestsList({
  me,
  onCreate,
  onOpen,
  initialStatus,
  tick = 0,
}: {
  me: Me;
  onCreate: () => void;
  onOpen: (id: string) => void;
  initialStatus?: string;
  tick?: number;
}) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Prefilter from a KPI/by-status click on the dashboard (deep-link via state).
  const [statusFilter, setStatusFilter] = useState(initialStatus ?? '');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false); // bug #12: calendar collapsed by default
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const PAGE = 30;
  const canSeeProcurement = me.permissions.includes('procurement.view') || me.permissions.includes('procurement.quote') || me.permissions.includes('procurement.select_supplier');

  // P1-7: search + status filter run on the SERVER (debounced 350ms), so they
  // match requests across the whole holding, not only the current page.
  useEffect(() => {
    let cancelled = false;
    // Silent refresh (no skeleton wipe) — keep the current list visible until new
    // data arrives; also fires on the 30s tick (bug #6).
    const t = setTimeout(() => {
      api.listRequests({ limit: PAGE, search: search.trim(), status: statusFilter }).then((res: any) => {
        if (cancelled) return;
        setError(null);
        if (Array.isArray(res)) { setRows(res); setHasMore(false); setTotal(res.length); }
        else { setRows(res.items); setHasMore(res.hasMore); setTotal(res.total ?? res.items.length); }
      }).catch((e) => { if (!cancelled) setError((e as Error).message); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, statusFilter, tick]);

  const loadMore = async () => {
    if (!rows || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.listRequests({ limit: PAGE, offset: rows.length, search: search.trim(), status: statusFilter }) as any;
      const next = Array.isArray(res) ? res : res.items;
      setRows([...rows, ...next]);
      setHasMore(Array.isArray(res) ? false : res.hasMore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  // Build set of dates that have requests (for calendar dots)
  const requestDates = new Set<string>();
  if (rows) {
    for (const r of rows) {
      if (r.createdAt) {
        const d = new Date(r.createdAt);
        requestDates.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }
    }
  }

  // Search + status are already applied server-side; only the calendar-day filter
  // is refined client-side over the loaded page.
  const filtered = rows?.filter((r) => {
    if (selectedDate && r.createdAt) {
      const d = new Date(r.createdAt);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (dateKey !== selectedDate) return false;
    }
    return true;
  });

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '14px 16px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--fg2)' }}>
            Все заявки {selectedDate ? (filtered ? `· ${filtered.length}` : '') : total != null ? `· ${total}` : ''}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* bug #12: calendar collapsed into a small toggle next to "+ Создать" */}
            <button
              aria-label="Календарь"
              onClick={() => setShowCalendar((v) => !v)}
              style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid var(--border)', background: showCalendar || selectedDate ? 'var(--accent-bg)' : 'var(--card)', color: showCalendar || selectedDate ? 'var(--accent)' : 'var(--fg2)', cursor: 'pointer', position: 'relative' }}
            >
              <Icon name="clock" size={18} />
              {selectedDate && <span style={{ position: 'absolute', top: -3, right: -3, width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
            </button>
            {me.permissions.includes('requests.create') && (
              <button onClick={onCreate} style={{ padding: '8px 13px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                + Создать
              </button>
            )}
          </div>
        </div>
        {showCalendar && (
          <div style={{ marginBottom: 8 }}>
            <MiniCalendar requestDates={requestDates} selectedDate={selectedDate} onSelect={(d) => { setSelectedDate(d); }} />
            {selectedDate && (
              <button onClick={() => setSelectedDate(null)} style={{ marginTop: 6, border: 'none', background: 'none', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>Сбросить дату</button>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по номеру или названию..."
            style={{ flex: 1, padding: '9px 13px', fontSize: 13, border: '1.5px solid var(--border)', borderRadius: 10, background: 'var(--card)', color: 'var(--fg)', outline: 'none', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '9px 10px', fontSize: 12, border: '1.5px solid var(--border)', borderRadius: 10, background: 'var(--card)', color: 'var(--fg)', outline: 'none', appearance: 'none', cursor: 'pointer' }}
          >
            <option value="">Все</option>
            <option value="pending_approval">На согласовании</option>
            <option value="approved">Согласована</option>
            <option value="rejected">Отклонена</option>
            <option value="draft">Черновик</option>
            <option value="warehouse_check">Склад</option>
            <option value="procurement">Закупка</option>
            <option value="finance_payment">Ожидает оплаты</option>
            <option value="delivery">Доставка</option>
            <option value="receiving">Приёмка</option>
            <option value="issue">Выдача</option>
            <option value="closed">Закрыта</option>
          </select>
        </div>
      </div>
      {error && <div style={{ padding: '0 16px' }}><Err>{error}</Err></div>}
      {!filtered && !error && <div style={{ padding: '4px 16px' }}><Skeleton /></div>}
      {filtered && filtered.length === 0 && (
        <div style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--chip)', color: 'var(--fg3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="file" size={34} />
          </span>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', marginTop: 18 }}>{search || statusFilter ? 'Ничего не найдено' : 'Здесь пока пусто'}</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', marginTop: 6, lineHeight: 1.5, maxWidth: 240 }}>{search || statusFilter ? 'Попробуйте другой запрос или сбросьте фильтр.' : 'Заявок нет. Создайте первую с главного экрана.'}</div>
          {!search && !statusFilter && me.permissions.includes('requests.create') && (
            <button onClick={onCreate} style={{ marginTop: 18, padding: '12px 20px', borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              + Новая заявка
            </button>
          )}
        </div>
      )}
      {filtered && filtered.length > 0 && (
        <div style={{ padding: '4px 16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groupByDay(filtered).map((g) => (
            <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <DateDivider label={g.label} />
              {g.items.map((r) => {
            const s = statusMeta(r.status);
            const isMine = r.requesterId === me.user.id;
            return (
              <button
                key={r.id}
                onClick={() => onOpen(r.id)}
                style={{ textAlign: 'left', background: isMine ? 'var(--accent-bg)' : 'var(--card)', border: `1px solid ${isMine ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 11 }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: s.color }} />
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: 'var(--fg2)', fontWeight: 500 }}>{r.requestNumber}</span>
                      {isMine && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent)', borderRadius: 6, padding: '2px 6px' }}>Создано мной</span>}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)', marginTop: 5, letterSpacing: '-.01em' }}>{r.title || 'Без названия'}</div>
                  </div>
                  <StatusPill status={r.status} />
                </div>
                {canSeeProcurement && <div style={{ fontSize: 12, color: 'var(--fg2)', fontFamily: "'IBM Plex Mono', monospace" }}>{money(r.estimatedAmount)} UZS</div>}
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
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              style={{ width: '100%', padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--accent)', fontSize: 14, fontWeight: 600, cursor: loadingMore ? 'wait' : 'pointer', opacity: loadingMore ? 0.5 : 1, marginTop: 4 }}
            >
              {loadingMore ? 'Загрузка...' : 'Показать ещё'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* InboxScreen is imported from ./screens/Inbox */

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
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [configUsers, setConfigUsers] = useState<{ id: string; fullName: string }[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [idx, setIdx] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submittedNo, setSubmittedNo] = useState<string | null>(null);
  const submitLock = useRef(false);

  useEffect(() => {
    api
      .form('request_create')
      .then(async (f: { fields?: FormField[] }) => {
        let whs: { id: string; name: string }[] = [];
        let depts: { id: string; name: string }[] = [];
        let usrs: { id: string; fullName: string }[] = [];
        try {
          const c = (await api.config()) as { warehouses?: { id: string; name: string }[]; departments?: { id: string; name: string }[]; users?: { id: string; fullName: string }[] };
          whs = c.warehouses ?? [];
          depts = c.departments ?? [];
          usrs = c.users ?? [];
        } catch {
          /* config is optional */
        }
        const fs = Array.isArray(f.fields) ? f.fields : [];
        setFields(fs);
        setWarehouses(whs);
        setDepartments(depts);
        setConfigUsers(usrs);
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
    f.key === 'cf_department'
      ? departments.map((d) => ({ value: d.name, label: d.name }))
      : f.key === 'cf_dept_head'
        ? configUsers.map((u) => ({ value: u.fullName, label: u.fullName }))
        : f.key === 'warehouse'
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
    // Urgency ↔ Date: if one is filled, the other becomes optional
    if (f.key === 'cf_urgency' && String(values['cf_urgency'] ?? '').trim() === '') {
      // urgency not filled — check if date IS filled (then urgency is optional)
      const dateVal = String(values[
        (fields ?? []).find((ff) => ff.type === 'date')?.key ?? ''
      ] ?? '').trim();
      if (dateVal) return true; // date is filled, urgency not required
    }
    if (f.type === 'date' && f.key !== 'cf_urgency') {
      // date field — check if urgency IS filled (then date is optional)
      const urgVal = String(values['cf_urgency'] ?? '').trim();
      if (urgVal) return true; // urgency is filled, date not required
    }
    // A required select with no available options (e.g. warehouse with no warehouses
    // configured) can't be filled — don't let it dead-lock the wizard.
    if (f.type === 'select' && optionsFor(f).length === 0) return true;
    if (f.type === 'checkbox') return v === true;
    if (f.type === 'number') return Number(v) > 0;
    return String(v ?? '').trim().length > 0;
  };
  const missingRequired = stepFields(steps[idx] ?? -1).filter((f) => f.required && !filled(f));

  const submit = async () => {
    if (submitLock.current) return;
    submitLock.current = true;
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
      if (itemName && !(quantity > 0)) throw new Error('Укажите количество больше нуля');
      payload.items = itemName ? [{ name: itemName, quantity, unitPrice: 0, unit }] : [];
      if (Object.keys(custom).length) payload.customFields = custom;
      const res = await api.createRequest(payload);
      // Upload attached files (if any)
      for (const f of fields ?? []) {
        if (f.type !== 'file') continue;
        const fileList = ((values as any)['__files_' + f.key] ?? []) as { name: string; data: string }[];
        for (const file of fileList) {
          try { await api.attachments.upload(res.id, { filename: file.name, dataBase64: file.data }); } catch { /* best-effort */ }
        }
      }
      setSubmittedNo(res.requestNumber ?? '—');
      setIdx(steps.length + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
      submitLock.current = false;
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
      // Long lists (>30 options like "Назначение и цель") become a compact dropdown.
      if (opts.length > 30) {
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
      // Split into primary chips + overflow roller when >4 options
      const PRIMARY_COUNT = 4;
      const hasManyOpts = opts.length > PRIMARY_COUNT;
      const primaryOpts = hasManyOpts ? opts.slice(0, PRIMARY_COUNT) : opts;
      const overflowOpts = hasManyOpts ? opts.slice(PRIMARY_COUNT) : [];
      const currentInOverflow = hasManyOpts && overflowOpts.some((o) => o.value === values[f.key]);
      return (
        <div>
          <div style={fieldLabel}>{f.label}{optional}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {primaryOpts.map((o) => {
              const on = values[f.key] === o.value;
              return (
                <button key={o.value} onClick={() => set(f.key, on && !f.required ? '' : o.value)} style={{ ...chip(on), flex: 'none' }}>{o.label}</button>
              );
            })}
          </div>
          {hasManyOpts && (
            <div style={{ marginTop: 10, position: 'relative' }}>
              <select
                value={currentInOverflow ? String(values[f.key] ?? '') : ''}
                onChange={(e) => set(f.key, e.target.value)}
                style={{ ...input, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', paddingRight: 38, cursor: 'pointer', fontSize: 13, color: currentInOverflow ? 'var(--fg)' : 'var(--fg3)' }}
              >
                <option value="">Другое...</option>
                {overflowOpts.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <span style={{ position: 'absolute', right: 14, top: '50%', marginTop: -8, pointerEvents: 'none', color: 'var(--fg3)', display: 'inline-block', transform: 'rotate(90deg)' }}>
                <Icon name="chev" size={16} sw={2.2} />
              </span>
            </div>
          )}
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
      const files = ((values as any)['__files_' + f.key] ?? []) as { name: string; size: number }[];
      return (
        <div>
          <label style={fieldLabel}>{f.label}{optional}</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, borderRadius: 12, border: '1.5px dashed var(--border)', background: 'var(--card)', cursor: 'pointer' }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-bg)', color: 'var(--accent)' }}><Icon name="camera" size={20} /></span>
            <div style={{ fontSize: 13, color: 'var(--fg2)' }}>{files.length ? `${files.length} файл(ов) выбрано` : 'Нажмите чтобы выбрать файл'}</div>
            <input type="file" multiple style={{ display: 'none' }} onChange={(e) => {
              const selected = e.target.files;
              if (!selected) return;
              const newFiles: { name: string; size: number; data: string }[] = [];
              let pending = selected.length;
              for (let i = 0; i < selected.length; i++) {
                const file = selected[i];
                if (file.size > 2 * 1024 * 1024) { setError('Файл ' + file.name + ' больше 2 МБ'); pending--; if (pending <= 0) { setValues((p) => ({ ...p, ['__files_' + f.key]: [...((p as any)['__files_' + f.key] || []), ...newFiles] as any })); } continue; }
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1] || '';
                  newFiles.push({ name: file.name, size: file.size, data: base64 });
                  pending--;
                  if (pending <= 0) {
                    setValues((p) => ({ ...p, ['__files_' + f.key]: [...((p as any)['__files_' + f.key] || []), ...newFiles] as any }));
                  }
                };
                reader.readAsDataURL(file);
              }
            }} />
          </label>
          {files.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {files.map((file, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 8, background: 'var(--chip)', fontSize: 12 }}>
                  <span style={{ color: 'var(--fg)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{file.name}</span>
                  <button onClick={() => setValues((p) => ({ ...p, ['__files_' + f.key]: (((p as any)['__files_' + f.key]) || []).filter((_: unknown, j: number) => j !== i) as any }))} style={{ border: 'none', background: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: '2px 6px' }}>x</button>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    return (
      <div>
        <label style={fieldLabel}>{f.label}{optional}</label>
        <input
          value={String(values[f.key] ?? '')}
          onChange={(e) => {
            if (f.type === 'number') {
              const n = Number(e.target.value);
              if (n < 0) return;
            }
            set(f.key, e.target.value);
          }}
          type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
          min={f.type === 'number' ? 0 : undefined}
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

function ImageThumb({ attachmentId, alt }: { attachmentId: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    const token = getToken();
    fetch(`/api/attachments/${attachmentId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);
  if (!src) return <span style={{ width: 40, height: 40, borderRadius: 8, flex: 'none', background: 'var(--skel)', display: 'block' }} />;
  return <img src={src} alt={alt} style={{ width: 40, height: 40, borderRadius: 8, flex: 'none', objectFit: 'cover' }} />;
}

function AttachmentsSection({ requestId }: { requestId: string }) {
  const [atts, setAtts] = useState<{ id: string; filename: string; mime: string; size: number }[] | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.attachments.list(requestId).then(setAtts).catch(() => setAtts([]));
  }, [requestId]);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('Файл больше 2 МБ'); return; }
    setUploading(true);
    try {
      const reader = new FileReader();
      const base64: string = await new Promise((resolve) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.readAsDataURL(file);
      });
      await api.attachments.upload(requestId, { filename: file.name, dataBase64: base64, mime: file.type });
      const fresh = await api.attachments.list(requestId);
      setAtts(fresh);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const remove = async (id: string) => {
    try {
      await api.attachments.remove(id);
      setAtts((prev) => prev?.filter((a) => a.id !== id) ?? null);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  if (!atts || (atts.length === 0 && !uploading)) {
    return (
      <div style={{ background: 'var(--card)', border: '1px dashed var(--border)', borderRadius: 14, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, color: 'var(--fg3)' }}>Нет вложений</span>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}>
          + Добавить
          <input type="file" style={{ display: 'none' }} onChange={upload} />
        </label>
      </div>
    );
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={SECTION_LABEL as any}>Вложения · {atts.length}</div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', cursor: uploading ? 'wait' : 'pointer', opacity: uploading ? 0.5 : 1 }}>
          {uploading ? '...' : '+ Файл'}
          <input type="file" style={{ display: 'none' }} onChange={upload} disabled={uploading} />
        </label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {atts.map((a) => {
          const isImage = a.mime?.startsWith('image/');
          return (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--chip)' }}>
              {isImage ? (
                <ImageThumb attachmentId={a.id} alt={a.filename} />
              ) : (
                <span style={{ width: 40, height: 40, borderRadius: 8, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--chip)', color: 'var(--fg3)' }}>
                  <Icon name="file" size={18} />
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</div>
                <div style={{ fontSize: 11, color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace" }}>{(a.size / 1024).toFixed(0)} KB</div>
              </div>
              <button onClick={async () => {
                try {
                  const token = getToken();
                  const res = await fetch(`/api/attachments/${a.id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
                  if (!res.ok) throw new Error('Download failed');
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url; link.download = a.filename; link.click();
                  URL.revokeObjectURL(url);
                } catch { alert('Не удалось скачать файл'); }
              }} style={{ border: 'none', background: 'none', fontSize: 12, fontWeight: 600, color: 'var(--accent)', cursor: 'pointer', padding: '4px 8px' }}>Скачать</button>
              <button onClick={() => remove(a.id)} style={{ border: 'none', background: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: '4px 6px' }}>x</button>
            </div>
          );
        })}
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

function RequestDetailView({ id, me, onBack, tick = 0 }: { id: string; me: Me; onBack: () => void; tick?: number }) {
  const [req, setReq] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<LifecycleActionBtn | null>(null);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Silent refresh (keeps current view; also fires on the 30s tick, bug #6).
    api.getRequest(id)
      .then(data => { if (!cancelled) { setReq(data); setError(null); } })
      .catch(e => { if (!cancelled && !req) setError((e as Error).message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tick]);

  const load = useCallback(() => {
    api.getRequest(id).then(setReq).catch((e) => setError((e as Error).message));
  }, [id]);

  const run = async (
    action: string,
    vals: { pin?: string; comment?: string; amount?: number; supplierName?: string; supplierId?: string; leadTime?: string; quotationId?: string; assigneeId?: string } = {},
  ) => {
    if (actionLock.current) return;
    actionLock.current = true;
    try {
      setBusy(true);
      setError(null);
      const res = await api.requestAction(id, { action, ...vals });
      setPending(null);
      load();
      if (res?.warnings?.length) {
        const msg = (res.warnings as string[]).join('\n');
        const tg = (window as { Telegram?: { WebApp?: { showAlert?: (m: string) => void } } }).Telegram?.WebApp;
        if (tg?.showAlert) tg.showAlert(msg);
        else window.alert(msg);
      }
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
      actionLock.current = false;
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
  const canSeeProcurement = me.permissions.includes('procurement.view') || me.permissions.includes('procurement.quote') || me.permissions.includes('procurement.select_supplier');
  const quotations = canSeeProcurement ? (req.quotations ?? []) : [];

  // Bug #5: the author may cancel their own request while no one has approved yet.
  const TERMINAL = ['approved', 'closed', 'rejected', 'cancelled', 'archived'];
  const canCancel =
    req.requesterId === me.user.id &&
    !TERMINAL.includes(req.status) &&
    !(req.approvals ?? []).some((a) => a.status === 'approved');
  const doCancel = async () => {
    if (!(await confirmDialog('Удалить заявку? Отменить это действие будет нельзя.'))) return;
    try {
      await api.cancelRequest(id);
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Full info (bug #9): show every meaningful field, not just status.
  const PRIORITY_LABEL: Record<string, string> = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный', critical: 'Критичный' };
  const TYPE_LABEL: Record<string, string> = { material_request: 'Материалы / товар', service_request: 'Услуга', other: 'Другое' };
  const info: { k: string; v: string }[] = [];
  const pushInfo = (k: string, v: unknown) => { if (v != null && String(v).trim() !== '') info.push({ k, v: String(v) }); };
  pushInfo('Статус', req.statusLabel ?? statusMeta(req.status).label);
  pushInfo('Автор', req.requesterName);
  pushInfo('Завод', req.factoryName);
  pushInfo('Отдел', req.departmentNameResolved ?? req.departmentName);
  pushInfo('Склад', req.warehouseName);
  pushInfo('Приоритет', req.priority ? (PRIORITY_LABEL[req.priority] ?? req.priority) : null);
  pushInfo('Тип', req.requestType ? (TYPE_LABEL[req.requestType] ?? req.requestType) : null);
  pushInfo('Ответственный', req.responsibleName);
  pushInfo('Нужно к', req.neededDate ? fmtDate(req.neededDate) : null);
  pushInfo('Создана', fmtDate(req.createdAt));
  if (req.canSeeMoney && req.estimatedAmount != null) pushInfo('Сумма', `${Number(req.estimatedAmount).toLocaleString('ru-RU')} ${req.currency || 'UZS'}`);
  pushInfo('Позиций', String(req.items.length));
  // Custom form fields entered at creation.
  const customEntries = req.customFields && typeof req.customFields === 'object' ? Object.entries(req.customFields as Record<string, unknown>) : [];

  return (
    <div style={{ padding: '16px 16px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--fg2)', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
          ← Назад
        </button>
        {canCancel && (
          <button onClick={doCancel} style={{ background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 11px', borderRadius: 9 }}>
            Удалить заявку
          </button>
        )}
      </div>

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

      {/* Progress timeline — top of the card (#10), per-step actor/date-time (#7), correct rejected state (#4) */}
      {(req.workflowTimeline ?? []).length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Прогресс согласования</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {(req.workflowTimeline ?? []).map((step, idx, arr) => {
              const last = idx === arr.length - 1;
              const done = step.state === 'completed';
              const cur = step.state === 'current';
              const rej = step.state === 'rejected';
              const color = rej ? 'var(--danger)' : done ? 'var(--success)' : cur ? 'var(--warning)' : 'var(--fg3)';
              const mark = rej ? '✕' : done ? '✓' : cur ? '●' : '';
              const lineColor = rej ? 'var(--danger)' : step.state === 'future' ? 'var(--line)' : color;
              return (
                <div key={step.stepId ?? idx} style={{ display: 'flex', gap: 13 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', marginTop: 2, flex: 'none', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700 }}>{mark}</span>
                    {!last && <span style={{ width: 2, flex: 1, minHeight: 26, background: lineColor }} />}
                  </div>
                  <div style={{ paddingBottom: 16, flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: step.state === 'future' ? 'var(--fg3)' : 'var(--fg)' }}>{step.stepName}</div>
                    <div style={{ fontSize: 11.5, marginTop: 2, fontWeight: cur || rej ? 600 : 500, color: rej ? 'var(--danger)' : cur ? 'var(--warning)' : done ? 'var(--success)' : 'var(--fg3)' }}>
                      {step.action === 'created' ? 'Создана' : rej ? 'Отклонено' : done ? 'Согласовано' : cur ? 'Текущий этап · ожидает' : 'Ожидает'}
                    </div>
                    {(step.actorName || step.at) && (
                      <div style={{ fontSize: 11, color: 'var(--fg3)', marginTop: 3, fontFamily: "'IBM Plex Mono', monospace" }}>
                        {step.actorName ?? ''}{step.actorRole ? ` · ${step.actorRole}` : ''}{step.at ? ` · ${fmtDateTime(step.at)}` : ''}
                      </div>
                    )}
                    {cur && <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 3, fontWeight: 600 }}>→ {nextActionHint(step.stepKind)}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {req.description && String(req.description).trim() !== '' && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Примечание</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{req.description}</div>
        </div>
      )}

      {customEntries.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Дополнительно</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 12px' }}>
            {customEntries.map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 11, color: 'var(--fg3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>{k}</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', marginTop: 3 }}>{v == null || v === '' ? '—' : String(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {req.items.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Позиции</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {req.items.map((it) => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <span style={{ fontSize: 14, color: 'var(--fg)', minWidth: 0 }}>
                  {it.name} <span style={{ color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace" }}>× {it.quantity}{it.unit ? ` ${it.unit}` : ''}</span>
                </span>
                {req.canSeeMoney && it.totalAmount != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', fontFamily: "'IBM Plex Mono', monospace", flex: 'none' }}>{Number(it.totalAmount).toLocaleString('ru-RU')}</span>
                )}
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

      <AttachmentsSection requestId={id} />

      {history.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>История действий</div>
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
                    {h.changedByName && (
                      <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>
                        {h.changedByName}
                        {h.changedByRole ? ` · ${h.changedByRole}` : ''}
                      </div>
                    )}
                    {h.comment && <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>{h.comment}</div>}
                    <div style={{ fontSize: 11, color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>{fmtDateTime(h.createdAt)}</div>
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
          requestId={id}
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
  requestId,
  busy,
  error,
  quotations,
  onCancel,
  onConfirm,
}: {
  action: LifecycleActionBtn;
  requestId: string;
  busy: boolean;
  error: string | null;
  quotations: QuotationRow[];
  onCancel: () => void;
  onConfirm: (vals: { pin?: string; comment?: string; amount?: number; supplierName?: string; supplierId?: string; leadTime?: string; quotationId?: string; assigneeId?: string }) => void;
}) {
  const [pin, setPin] = useState('');
  const [comment, setComment] = useState('');
  // Bug #3: role-based rejection reasons + «Другое» → free text.
  const isReject = action.action === 'reject';
  const [reasons, setReasons] = useState<string[]>([]);
  const [reasonChoice, setReasonChoice] = useState('');
  useEffect(() => {
    if (isReject) api.rejectReasons(requestId).then((r: any) => setReasons(r?.reasons ?? [])).catch(() => setReasons([]));
  }, [isReject, requestId]);
  const OTHER = '__other__';

  // Bug #8: procurement head assigns a specific снабженец.
  const isAssign = !!action.assign;
  const [assignees, setAssignees] = useState<{ id: string; fullName: string | null }[]>([]);
  const [assigneeId, setAssigneeId] = useState('');
  useEffect(() => {
    if (isAssign) api.procurementAssignees().then((r) => setAssignees(r?.users ?? [])).catch(() => setAssignees([]));
  }, [isAssign]);
  const [amount, setAmount] = useState('');
  const [supplier, setSupplier] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [leadTime, setLeadTime] = useState('');
  const [quotationId, setQuotationId] = useState(quotations.find((q) => q.selected)?.id ?? '');
  const isAdd = action.quote === 'add';
  const isSelect = action.quote === 'select';
  useEffect(() => {
    if (isAdd) api.suppliers.list().then(setSuppliers).catch(() => {});
  }, [isAdd]);
  const inputStyle: CSSProperties = { width: '100%', padding: '13px 15px', fontSize: 15, border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" };
  const lbl: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 8 };
  // Effective reject comment: chosen preset, or free text when «Другое».
  const effectiveComment = isReject && reasons.length > 0
    ? (reasonChoice === OTHER ? comment.trim() : reasonChoice)
    : comment.trim();
  const ok =
    (!action.pin || pin.length >= 4) &&
    (!action.comment || effectiveComment.length > 0) &&
    (!action.amount || (amount !== '' && Number(amount) > 0)) &&
    (!isAdd || ((supplierId !== '' || supplier.trim().length > 0) && amount !== '' && Number(amount) > 0)) &&
    (!isSelect || quotationId !== '') &&
    (!isAssign || assigneeId !== '');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={onCancel} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>{action.label}</div>
        {isAssign && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Снабженец</div>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={inputStyle}>
              <option value="" disabled>Выберите снабженца…</option>
              {assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName || a.id}</option>)}
            </select>
            {assignees.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 6 }}>Нет пользователей с правами снабжения</div>}
          </div>
        )}
        {isAdd && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>Поставщик</div>
              {suppliers.length > 0 && (
                <select
                  value={supplierId}
                  onChange={(e) => {
                    setSupplierId(e.target.value);
                    const s = suppliers.find((x) => x.id === e.target.value);
                    if (s) setSupplier(s.name);
                  }}
                  style={inputStyle}
                >
                  <option value="">— выберите из справочника —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              {!supplierId && (
                <input
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  placeholder={suppliers.length > 0 ? 'или впишите вручную' : 'напр. ООО «Метизы»'}
                  style={{ ...inputStyle, marginTop: suppliers.length > 0 ? 8 : 0 }}
                />
              )}
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
        {action.amount && !isAdd && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Сумма КП (UZS)</div>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="0" style={{ ...inputStyle, fontFamily: "'IBM Plex Mono', monospace" }} />
          </div>
        )}
        {action.comment && isReject && reasons.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Причина отклонения</div>
            <select value={reasonChoice} onChange={(e) => setReasonChoice(e.target.value)} style={inputStyle}>
              <option value="" disabled>Выберите причину…</option>
              {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value={OTHER}>Другое…</option>
            </select>
            {reasonChoice === OTHER && (
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Укажите причину" style={{ ...inputStyle, resize: 'none', lineHeight: 1.45, marginTop: 8 }} />
            )}
          </div>
        )}
        {action.comment && !(isReject && reasons.length > 0) && (
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
                comment: action.comment ? effectiveComment : undefined,
                amount: action.amount || isAdd ? Number(amount) : undefined,
                supplierId: isAdd && supplierId ? supplierId : undefined,
                supplierName: isAdd ? supplier.trim() || undefined : undefined,
                leadTime: isAdd && leadTime.trim() ? leadTime.trim() : undefined,
                quotationId: isSelect ? quotationId : undefined,
                assigneeId: isAssign ? assigneeId : undefined,
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
interface DevUser {
  username: string;
  fullName: string;
  roles: string[];
}

/** Test-mode switch: pin THIS WINDOW to a test user via `?user=` (boot re-logins). */
function switchTestUser(username: string): void {
  window.location.href = '/?user=' + encodeURIComponent(username);
}

/**
 * DEV MODE panel — per-window test-user switcher (docs/TEST_MODE.md). Rendered
 * only when /api/dev/users answered, i.e. never in production (stealth 404).
 */
function DevSwitcher({ users, pin, current }: { users: DevUser[]; pin: string; current: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="DEV: сменить пользователя"
        style={{ position: 'fixed', right: 12, bottom: 84, zIndex: 60, padding: '8px 12px', borderRadius: 12, border: 'none', background: '#7c3aed', color: '#fff', fontSize: 12, fontWeight: 800, letterSpacing: '.05em', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.35)' }}
      >
        DEV{current ? `: ${current}` : ''}
      </button>
      {open && (
        <div style={{ position: 'fixed', right: 12, bottom: 128, zIndex: 60, width: 268, maxHeight: '60vh', overflowY: 'auto', borderRadius: 14, background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--line)', boxShadow: '0 10px 30px rgba(0,0,0,.45)', padding: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.07em', opacity: 0.7, margin: '2px 4px 8px' }}>
            DEV MODE — пользователь этого окна · PIN: {pin}
          </div>
          {users.map((u) => (
            <button
              key={u.username}
              onClick={() => switchTestUser(u.username)}
              disabled={u.username === current}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4, borderRadius: 10, border: 'none', cursor: u.username === current ? 'default' : 'pointer', background: u.username === current ? '#7c3aed' : 'rgba(127,127,127,.14)', color: u.username === current ? '#fff' : 'inherit' }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>{u.fullName}</div>
              <div style={{ fontSize: 11, opacity: 0.72 }}>{u.username} · {u.roles.join(', ')}</div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function DevLogin({ testUsers, error, onLoggedIn }: { testUsers: DevUser[] | null; error: string | null; onLoggedIn: () => void }) {
  const [tgId, setTgId] = useState('');
  const [err, setErr] = useState<string | null>(error);
  const [loading, setLoading] = useState(false);

  const login = async () => {
    setErr(null);
    setLoading(true);
    try {
      const r = await api.loginDev(tgId.trim());
      setToken(r.token);
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Centered>
      <div className="w-full max-w-xs">
        <div className="mb-1 text-center text-2xl font-bold tracking-tight text-fg">⚙️ Factory OS</div>
        <p className="mb-5 text-center text-xs leading-relaxed text-fg3">
          Откройте внутри Telegram для обычного входа. Локально — dev-вход по Telegram ID.
        </p>
        {testUsers && testUsers.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-center text-[11px] font-bold uppercase tracking-wider text-fg3">Тестовые пользователи</div>
            {testUsers.map((u) => (
              <button
                key={u.username}
                onClick={() => switchTestUser(u.username)}
                className="mb-1 w-full rounded-xl border border-line bg-card px-3.5 py-2 text-left active:scale-[.98]"
              >
                <div className="text-[13px] font-semibold text-fg">{u.fullName}</div>
                <div className="text-[11px] text-fg3">{u.username} · {u.roles.join(', ')}</div>
              </button>
            ))}
          </div>
        )}
        <input
          value={tgId}
          onChange={(e) => setTgId(e.target.value)}
          placeholder="Ваш Telegram ID"
          className="mb-2.5 w-full rounded-xl border border-line bg-card px-3.5 py-3 text-center font-mono text-sm text-fg outline-none placeholder:text-fg3 focus:border-accent"
        />
        <button
          onClick={login}
          disabled={loading}
          className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white shadow-lg shadow-accent/20 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Вход...' : 'Войти (dev)'}
        </button>
        {err && <Err>{err}</Err>}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-6 text-fg2">{children}</div>;
}
function nextActionHint(stepKind: string): string {
  switch (stepKind) {
    case 'approval': return 'Ожидает согласования';
    case 'warehouse_check': return 'Склад должен проверить наличие';
    case 'procurement': return 'Снабжение подбирает поставщика';
    case 'finance_payment': return 'Ожидает оплаты';
    case 'delivery': return 'Ожидает доставки';
    case 'receiving': return 'Склад принимает товар';
    case 'issue': return 'Склад должен выдать материал';
    case 'close': return 'Ожидает подтверждения получения';
    default: return 'Ожидает действия';
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
