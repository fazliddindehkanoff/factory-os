import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, clearToken, getToken, setToken, getTestUser, setTestUser, type CreateRequestData } from './api';
import { getTelegram, confirmDialog } from './telegram';
import { AdminPanel } from './admin/AdminPanel';
import { WarehouseScreen } from './screens/Warehouse';
import { InboxScreen } from './screens/Inbox';
import { ProcurementScreen } from './screens/Procurement';
import { Icon, TINT_BG, TINT_FG } from './icons';
import { applyTheme, getTheme, type Theme } from './theme';
import { DASHBOARD_ACTIONS } from './dashboard.config';
import { LANG_LABELS, SWITCHER_LANGS, LANGUAGE_RELOAD_EVENT, useI18n, localizedName, type I18nKey, type Lang } from './i18n';
// Single source of truth for status labels/progress (covers every workflow-driven
// status incl. finance_payment/delivery/receiving/issue) — see screens/shared.tsx.
import { statusMeta } from './screens/shared';

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
const WAREHOUSE_STOCK_ACTIONS = new Set(['wh_in_stock', 'wh_partial', 'wh_out_of_stock']);
const isHiddenProcurementTransfer = (a: { action: string; label: string }) => a.action === 'assign_procurement' && a.label === 'Передать снабженцу';
const isHiddenProcurementIntake = (a: { action: string; label: string }) => a.action === 'accept_to_work' && a.label === 'Принять в работу';
const ACTION_LABEL_KEYS: Record<string, I18nKey> = {
  approve: 'action.approve',
  reject: 'action.reject',
  return_revision: 'action.returnRevision',
  add_quotation: 'action.addQuotation',
  approve_price: 'action.approvePrice',
  wh_in_stock: 'action.whNext',
  receive_full: 'action.receiveFull',
  place_order: 'action.placeOrder',
};

// ── Types ────────────────────────────────────────────────────────────────────
interface Me {
  user: { id: string; fullName: string; holdingId: string | null; roleName?: string | null; roleCodes?: string[] };
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
  // Лист Excel №5: поля карточки списка «как раньше».
  departmentNameResolved?: string | null;
  departmentName?: string | null;
  neededDate?: string | null;
  customFields?: Record<string, unknown> | null;
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

function displayLifecycleActions(status: string, actions: LifecycleActionBtn[]): LifecycleActionBtn[] {
  const visible = actions.filter((a) => !isHiddenProcurementTransfer(a) && !isHiddenProcurementIntake(a));
  if (status !== 'warehouse_check' || !visible.some((a) => WAREHOUSE_STOCK_ACTIONS.has(a.action))) return visible;
  const next = visible.find((a) => a.action === 'wh_in_stock') ?? visible.find((a) => WAREHOUSE_STOCK_ACTIONS.has(a.action));
  return [
    ...(next ? [{ ...next, action: 'wh_in_stock', label: 'Далее', pin: false, comment: false, amount: false, quote: null, assign: false }] : []),
    ...visible.filter((a) => !WAREHOUSE_STOCK_ACTIONS.has(a.action)),
  ];
}
interface QuotationRow {
  id: string;
  supplierName: string;
  amount: number;
  ndsIncluded?: boolean | null;
  paymentType?: string | null;
  leadTime: string | null;
  note: string | null;
  selected: boolean;
}
type DetailItem = RequestDetail['items'][number];
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
  state: 'completed' | 'current' | 'future' | 'rejected' | 'cancelled' | 'returned';
  actorName?: string | null;
  actorRole?: string | null;
  at?: string | null;
  action?: string | null;
  comment?: string | null;
}
interface RequestDetail extends RequestRow {
  items: { id: string; name: string; description?: string | null; quantity: string; unit?: string | null; estimatedPrice?: number | null; totalAmount: number | null; supplierName?: string | null; ndsIncluded?: boolean | null; paymentType?: string | null; status?: string | null; receivedQty?: string | null }[];
  approvals: ApprovalRow[];
  statusLabel?: string;
  statusHistory?: StatusHistoryRow[];
  quotations?: QuotationRow[];
  actions?: LifecycleActionBtn[];
  workflowTimeline?: WorkflowTimelineStep[];
  canSeeMoney?: boolean;
  /** Сервер: этот пользователь может править заявку на текущем этапе (PUT /requests/:id). */
  canEdit?: boolean;
  /** Кастомные поля с подписями из конструктора формы (сервер резолвит ключи и коды). */
  customInfo?: { label: string; value: string }[];
  // full-info fields (bug #9)
  requesterName?: string | null;
  responsibleName?: string | null;
  factoryName?: string | null;
  departmentNameResolved?: string | null;
  departmentName?: string | null;
  departmentId?: string | null;
  warehouseName?: string | null;
  priority?: string | null;
  requestType?: string | null;
  neededDate?: string | null;
  orderStatus?: string | null;
  description?: string | null;
  customFields?: Record<string, unknown> | null;
  updatedAt?: string | null;
  currency?: string | null;
}
type Screen =
  | { name: 'home' }
  // `status` — optional prefilter applied when the list opens (KPI/by-status click).
  // `mine` — open with the «Только мои» filter on (from the «Созданные мной» KPI).
  | { name: 'list'; status?: string; mine?: boolean }
  | { name: 'create' }
  // `from` — the screen that opened the detail, so "back" returns to the source.
  | { name: 'detail'; id: string; from?: 'home' | 'list' | 'approvals' | 'procurement' | 'notifications' }
  | { name: 'approvals' }
  | { name: 'warehouse' }
  | { name: 'procurement' }
  | { name: 'notifications' }
  | { name: 'menu' }
  | { name: 'admin' };

const SCREEN_DRAFT_KEY = 'factoryos.langSwitch.screen';
const CREATE_DRAFT_KEY = 'factoryos.langSwitch.createDraft';

function initialScreen(): Screen {
  try {
    const raw = sessionStorage.getItem(SCREEN_DRAFT_KEY);
    if (!raw) return { name: 'home' };
    sessionStorage.removeItem(SCREEN_DRAFT_KEY);
    const saved = JSON.parse(raw) as Screen;
    if (saved && typeof saved === 'object' && 'name' in saved) return saved;
  } catch {
    /* ignore malformed one-shot screen drafts */
  }
  return { name: 'home' };
}

interface DashboardData {
  myActive: number;
  myCreated: number;
  myReturned: number;
  pendingForMe: number;
  totalActive: number;
  activity: { id: string; requestNumber: string; status: string; title: string | null; obyekt?: string | null; departmentName?: string | null; neededDate?: string | null; createdAt?: string | null }[];
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
  const { lang, setLang, t } = useI18n();
  const [me, setMe] = useState<Me | null>(null);
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>(() => initialScreen());
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

  useEffect(() => {
    const saveScreen = () => sessionStorage.setItem(SCREEN_DRAFT_KEY, JSON.stringify(screen));
    window.addEventListener(LANGUAGE_RELOAD_EVENT, saveScreen);
    return () => window.removeEventListener(LANGUAGE_RELOAD_EVENT, saveScreen);
  }, [screen]);

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
        // Test mode (docs/TEST_MODE.md): `?phone=+998...` (or legacy
        // `?user=sklad_01`) pins THIS WINDOW to a test
        // user — the token lives in sessionStorage, so several windows can run
        // different roles side by side. Dev auth is stealth-404 in production, so a
        // stray ?user= there simply falls through to the normal login paths.
        const query = new URLSearchParams(window.location.search);
        const urlUser = (query.get('phone') ?? query.get('user'))?.trim();
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
    home: t('nav.home'),
    list: t('nav.requests'),
    create: 'Новая заявка',
    detail: t('screen.detail'),
    approvals: t('nav.approvals'),
    warehouse: t('nav.warehouse'),
    procurement: t('nav.procurement'),
    notifications: 'Уведомления',
    menu: t('nav.menu'),
    admin: 'Администрирование',
  };
  const title = TITLES[screen.name];
  const fullBleed = ['home', 'list', 'detail', 'create', 'approvals', 'warehouse', 'notifications'].includes(screen.name);
  // Нижняя навигация видна всегда (№2): и в карточке заявки, и в мастере создания.
  const showNav = true;
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
            <select
              aria-label={t('menu.language')}
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
              style={{ width: 58, height: 38, border: 'none', borderRadius: 11, background: 'rgba(255,255,255,.12)', color: 'var(--hfg)', padding: '0 6px', fontSize: 12, fontWeight: 800, cursor: 'pointer', outline: 'none' }}
            >
              {/* FIXES 2026-07-17 (лист H): Uzb / Рус / Türkçe (Eng заменён турецким). */}
              {SWITCHER_LANGS.map((code) => <option key={code} value={code}>{LANG_LABELS[code]}</option>)}
            </select>
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
            {/* FIXES 2026-07-17: имя пользователя в шапке убрано — оно и так есть
                в приветствии на главной. */}
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
            initialMine={screen.mine}
            onCreate={() => setScreen({ name: 'create' })}
            onOpen={(id) => setScreen({ name: 'detail', id, from: 'list' })}
          />
        )}
        {screen.name === 'create' && <CreateRequest me={me} onDone={() => setScreen({ name: 'list' })} onCreated={(id) => setScreen({ name: 'detail', id, from: 'list' })} />}
        {screen.name === 'detail' && (
          <RequestDetailView id={screen.id} me={me} tick={tick} onBack={() => setScreen({ name: screen.from ?? 'list' } as Screen)} />
        )}
        {screen.name === 'approvals' && <InboxScreen onOpen={(id) => setScreen({ name: 'detail', id, from: 'approvals' })} permissions={me.permissions} tick={tick} />}
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
          <AdminPanel permissions={me.permissions} isOwner={!!me.user.roleCodes?.includes('owner')} onExit={() => setScreen({ name: 'home' })} />
        )}
      </main>

      {showNav && <BottomNav me={me} active={screen.name} onNav={setScreen} />}
      {devUsers && devUsers.length > 0 && <DevSwitcher users={devUsers} pin={devPin} current={getTestUser()} />}
    </div>
  );
}

function BottomNav({ me, active, onNav }: { me: Me; active: Screen['name']; onNav: (s: Screen) => void }) {
  const { t } = useI18n();
  const can = (p: string) => me.permissions.includes(p);
  const isAdmin = ADMIN_PERMS.some(can);
  // Anyone who can take a lifecycle action (approve, check stock, quote, pay, receive…)
  // gets the inbox tab — not just final approvers.
  const canAct = INBOX_ACTOR_PERMS.some(can);
  const tabs: { key: Screen['name']; label: string; ic: string }[] = [{ key: 'home', label: t('nav.home'), ic: 'home' }];
  if (can('requests.view')) tabs.push({ key: 'list', label: t('nav.requests'), ic: 'file' });
  if (canAct) tabs.push({ key: 'approvals', label: t('nav.approvals'), ic: 'checkCircle' });
  // Independent tabs: warehouse/procurement show by their own permission,
  // in parallel with the admin tab (an else-if chain hid them from combined roles).
  if (isAdmin) tabs.push({ key: 'admin', label: t('nav.admin'), ic: 'shield' });
  if (can('warehouse.view')) tabs.push({ key: 'warehouse', label: t('nav.warehouse'), ic: 'box' });
  if (can('procurement.view')) tabs.push({ key: 'procurement', label: t('nav.procurement'), ic: 'box' });
  tabs.push({ key: 'menu', label: t('nav.menu'), ic: 'grid' });

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
  const { t } = useI18n();
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
          <div style={{ fontSize: 12.5, color: 'var(--fg2)' }}>{roleLabel(me.permissions, me.user.roleName, t)} · {me.permissions.length} прав</div>
        </div>
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', overflow: 'hidden' }}>
        <button onClick={onToggleTheme} style={{ ...rowStyle, borderTop: 'none' }}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
          </span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{t('menu.theme')}</span>
          <span style={{ fontSize: 13, color: 'var(--fg2)' }}>{theme === 'dark' ? t('menu.themeDark') : t('menu.themeLight')}</span>
        </button>
        <button onClick={() => { setProfileOpen(true); setPMsg(null); }} style={{ ...rowStyle, borderTop: 'none' }}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="gear" size={19} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{t('menu.profile')}</span>
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
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--danger)' }}>{t('menu.logout')}</span>
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
function roleLabel(perms: string[], roleName: string | null | undefined, t: (key: I18nKey) => string): string {
  if (roleName) return roleName === 'Assistant' ? t('role.assistant') : roleName;
  if (perms.includes('approvals.override')) return 'Учредитель';
  if (perms.includes('roles.manage') || perms.includes('settings.manage')) return 'Администратор';
  if (perms.includes('finance.mark_paid')) return 'Финансы';
  if (perms.includes('procurement.select_supplier')) return 'Закупки';
  if (perms.includes('warehouse.issue')) return 'Склад';
  if (perms.includes('approvals.approve')) return 'Согласующий';
  if (perms.includes('requests.create')) return t('role.assistant');
  return 'Сотрудник';
}

const SECTION_LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--fg2)',
  marginBottom: 12,
};

// A compact request card shared by the recent-activity feed and the queue previews.
// Лист Excel №5: когда переданы сведения о заявке (объект/отдел/даты), строка
// показывает № заявки и эти сведения, а не наименование товара.
function RequestRowButton({ id, title, requestNumber, status, onOpen, obyekt, departmentName, createdAt }: {
  id: string; title: string | null; requestNumber: string; status: string; onOpen: (id: string) => void;
  obyekt?: string | null; departmentName?: string | null; neededDate?: string | null; createdAt?: string | null;
}) {
  const rows: { k: string; v: string }[] = [];
  if (obyekt) rows.push({ k: 'Объект', v: obyekt });
  if (departmentName) rows.push({ k: 'Отдел снабжения', v: departmentName });
  if (createdAt) rows.push({ k: 'Создана', v: fmtDate(createdAt) });
  return (
    <button
      onClick={() => onOpen(id)}
      style={{ width: '100%', textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadowSm)', padding: '12px 13px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 700, color: 'var(--fg)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{requestNumber}</div>
          {!obyekt && title && <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>}
        </div>
        <StatusPill status={status} />
      </div>
      {rows.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((r) => (
            <div key={r.k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontSize: 11.5, color: 'var(--fg3)', fontWeight: 500, flex: 'none' }}>{r.k}</span>
              <span style={{ fontSize: 12.5, color: 'var(--fg)', fontWeight: 600, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.v}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--fg2)' }}>{statusMeta(status).label}</div>
      )}
    </button>
  );
}

type QueueItem = { id: string; title: string | null; requestNumber: string; status: string; obyekt?: string | null; departmentName?: string | null; neededDate?: string | null; createdAt?: string | null };
// Лист Excel №5: очереди на главной показывают те же сведения, что и карточки
// списка (объект/отдел/даты) — вытягиваем их из inbox (obyekt) и из сырой заявки
// (customFields.obyekt, departmentNameResolved).
const normalizeReq = (x: any): QueueItem => ({
  id: x.id,
  title: x.title ?? null,
  requestNumber: x.requestNumber ?? '',
  status: x.status ?? '',
  obyekt: x.obyekt ?? (x.customFields && typeof x.customFields === 'object' ? (x.customFields.obyekt ?? null) : null),
  departmentName: x.departmentNameResolved ?? x.departmentName ?? null,
  neededDate: x.neededDate ?? null,
  createdAt: x.createdAt ?? null,
});
const pickItems = (res: any): QueueItem[] => (Array.isArray(res) ? res : res?.items ?? []).map(normalizeReq);

// Role-aware queue preview: fetches a list endpoint, shows top items with
// loading / empty / error states. Used for "My Approvals" and the profile queue.
function QueuePreview({ title, load, onOpen, onSeeAll, emptyText, tick = 0 }: {
  title: string;
  load: () => Promise<QueueItem[]>;
  onOpen: (id: string) => void;
  onSeeAll?: () => void;
  emptyText: string;
  tick?: number;
}) {
  const [rows, setRows] = useState<QueueItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // №8: блок обновляется на том же 30с-тике, что и KPI-плитки, иначе
    // «Ожидают меня» и «Ждут моего решения» расходятся до перезахода на экран.
    // Тихий рефреш: старые данные видимы, скелетон — только при первой загрузке.
    load().then((r) => { if (alive) { setRows(r); setErr(null); } }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, tick]);
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {top.map((r) => <RequestRowButton key={r.id} {...r} onOpen={onOpen} />)}
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
  kind: string | null; // тип события (step_pending | configuration | approved_final | ...), null у старых строк
  status: string; // pending | delivered (=unread) | read | failed
  errorMessage: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

// Тег карточки — ТИП события (что случилось с заявкой), а не статус доставки:
// раньше каждая карточка кричала «Не доставлено» из-за отсутствия TG-канала.
const NOTIF_KIND: Record<string, { label: string; tint: string }> = {
  step_pending: { label: 'Ждёт вас', tint: 'accent' },
  stage_passed: { label: 'Этап пройден', tint: 'accent' },
  approved_final: { label: 'Согласована', tint: 'success' },
  rejected: { label: 'Отклонена', tint: 'danger' },
  needs_revision: { label: 'Возвращено на доработку', tint: 'warning' },
  returned_step: { label: 'Возврат на этап', tint: 'warning' },
  closed: { label: 'Закрыта', tint: 'success' },
  configuration: { label: 'Настройка', tint: 'warning' },
  security: { label: 'Безопасность', tint: 'warning' },
  escalation: { label: 'Просрочено', tint: 'danger' },
  digest: { label: 'Сводка', tint: 'accent' },
};
// Fallback для строк без kind (созданы до 0017) — прежние статусные ярлыки.
const NOTIF_STATUS: Record<string, { label: string; tint: string }> = {
  delivered: { label: 'Новое', tint: 'accent' },
  read: { label: 'Прочитано', tint: 'success' },
  failed: { label: 'Новое', tint: 'accent' },
  pending: { label: 'Отправляется', tint: 'warning' },
};
// Priority accent — a coloured left rail for the ones that matter.
const NOTIF_PRIORITY_TINT: Record<string, string> = { critical: 'danger', urgent: 'danger', high: 'warning' };

function fmtDateTime(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function NotificationsScreen({ onOpenRequest, onChanged }: { onOpenRequest: (id: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<NotifItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Вкладка «Непрочитанные» убрана по фидбеку владельца (чат 03.07) — остаётся
  // один список + «Прочитать все»; непрочитанные и так выделены визуально.
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(() => {
    setItems(null); setErr(null);
    api.notifications().then((r: any) => setItems(r?.items ?? [])).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load]);

  // №9: непрочитанное = всё, что не 'read' (в т.ч. pending/failed — пуш мог не уйти,
  // но in-app уведомление существует). Синхронно с серверным unreadCount.
  const markRead = async (n: NotifItem) => {
    if (n.status === 'read') return;
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
  const visible = items;
  const hasUnread = (items ?? []).some((n) => n.status !== 'read');

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
            Уведомлений пока нет.
          </div>
        )}
        {visible && visible.map((n) => {
          const st = (n.kind && NOTIF_KIND[n.kind]) || NOTIF_STATUS[n.status] || { label: 'Новое', tint: 'accent' };
          const unreadRow = n.status !== 'read';
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
              {/* Техническая причина сбоя TG-доставки пользователю не показывается —
                  in-app уведомление он уже читает. Мягкая пометка вместо красного крика. */}
              {n.status === 'failed' && (
                <div style={{ fontSize: 11.5, color: 'var(--fg3)', marginTop: 6 }}>Пуш в Telegram не дошёл — уведомление доступно здесь</div>
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
  const { t } = useI18n();
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
  // Лист Excel №14: возвращённые автору на доработку — отдельная плитка ПЕРЕД
  // «Созданные мной» (показываем только когда есть что дорабатывать).
  if (can('requests.create') && dash && dash.myReturned > 0) cards.push({ key: 'returned', label: 'Возвращённые', value: dash.myReturned, tint: 'warning', ic: 'alert', onClick: () => onNav({ name: 'list', status: 'needs_revision' }) });
  // Only request authors need author-centric cards. Operational roles often have
  // requests.view for visibility but do not create заявки.
  // FIXES 2026-07-17: цифра = все мои заявки, клик открывает список «Только мои» —
  // так плитка и список показывают одно и то же число.
  if (can('requests.create')) cards.push({ key: 'myActive', label: 'Созданные мной', value: dash?.myCreated ?? null, tint: 'accent', ic: 'file', onClick: () => onNav({ name: 'list', mine: true }) });
  // FIXES 2026-07-17 (лист G): «Ожидают меня» видит и снабженец — заявки до
  // простановки цены ждут его действия в этой очереди.
  if (can('approvals.approve') || can('procurement.view')) cards.push({ key: 'pending', label: 'Ожидают меня', value: dash?.pendingForMe ?? null, tint: 'warning', ic: 'checkCircle', onClick: () => onNav({ name: 'approvals' }) });
  if (oversight) cards.push({ key: 'total', label: 'Активных всего', value: dash?.totalActive ?? null, tint: 'success', ic: 'box', onClick: () => onNav({ name: 'list' }) });
  if (dash?.awaitingPayment != null) cards.push({ key: 'awaiting', label: 'Ожидают оплаты', value: dash.awaitingPayment, tint: 'warning', ic: 'wallet', onClick: () => onNav({ name: 'list', status: 'finance_payment' }) });
  // FIXES 2026-07-17 (лист G): «Для закупа» — заявки, согласованные директором
  // (этап «Оформление заказа»), а не всё, что в поиске поставщика.
  if (dash && dash.inProcurement != null) cards.push({ key: 'proc', label: 'Для закупа', value: dash.inProcurement, tint: 'accent', ic: 'truck', onClick: () => onNav({ name: 'list', status: 'ordering' }) });
  if (dash && dash.lowStock != null) cards.push({ key: 'low', label: 'Низкий остаток', value: dash.lowStock, tint: 'danger', ic: 'alert', onClick: () => onNav({ name: 'warehouse' }) });
  // Unread is shown via the header bell badge, not a dashboard card (per request).

  // by-status breakdown (oversight only) — chips deep-link to the filtered list.
  const byStatus = dash?.byStatus ?? null;
  const byStatusEntries = byStatus ? Object.entries(byStatus).sort((a, b) => b[1] - a[1]) : [];

  // Profile queue (one, by role) — only endpoints that exist as a single call.
  // NOTE: warehouse "receiving|issue" tasks need a multi-status list the API does
  // not expose (out of this sprint's backend scope), so warehouse users get a link
  // to the Warehouse screen instead of an inline list — not a silent single-status hack.
  // FIXES 2026-07-17 (лист G): секция «Ожидают оплаты» убрана — не нужна.
  const profileQueue: { title: string; load: () => Promise<QueueItem[]>; onSeeAll?: () => void; emptyText: string } | null =
    can('procurement.view')
      ? { title: 'Очередь снабжения', load: async () => pickItems(await api.procurement.queue()), onSeeAll: () => onNav({ name: 'procurement' }), emptyText: 'Нет заявок в закупке.' }
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
          {roleLabel(me.permissions, me.user.roleName, t)}
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 12, padding: '0 16px 4px' }}>
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
              const base: CSSProperties = { minWidth: 0, width: '100%', minHeight: 118, textAlign: 'left', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: 9 };
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

      {/* requests-by-status breakdown — FIXES 2026-07-17 (лист F): у всех пользователей. */}
      {!err && byStatusEntries.length > 0 && (
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
          tick={tick}
        />
      )}

      {/* Queue slot 2 — profile queue (procurement / finance) */}
      {!err && profileQueue && (
        <QueuePreview title={profileQueue.title} load={profileQueue.load} onOpen={onOpen} onSeeAll={profileQueue.onSeeAll} emptyText={profileQueue.emptyText} tick={tick} />
      )}

      {/* FIXES 2026-07-17 (лист D): карточка «Приёмка и выдача» убрана — на склад
          ведут карточка «Низкий остаток» и вкладка «Склад» в нижней навигации. */}

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {dash.activity.map((e) => (
              <RequestRowButton key={e.id} id={e.id} title={e.title} requestNumber={e.requestNumber} status={e.status} obyekt={e.obyekt} departmentName={e.departmentName} createdAt={e.createdAt} onOpen={onOpen} />
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
  initialMine,
  tick = 0,
}: {
  me: Me;
  onCreate: () => void;
  onOpen: (id: string) => void;
  initialStatus?: string;
  initialMine?: boolean;
  tick?: number;
}) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Prefilter from a KPI/by-status click on the dashboard (deep-link via state).
  const [statusFilter, setStatusFilter] = useState(initialStatus ?? '');
  const [mineOnly, setMineOnly] = useState(initialMine ?? false); // №13: «Только мои» (FIXES 2026-07-17: предустановка из плитки «Созданные мной»)
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false); // bug #12: calendar collapsed by default
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const PAGE = 30;

  // P1-7: search + status filter run on the SERVER (debounced 350ms), so they
  // match requests across the whole holding, not only the current page.
  useEffect(() => {
    let cancelled = false;
    // Silent refresh (no skeleton wipe) — keep the current list visible until new
    // data arrives; also fires on the 30s tick (bug #6).
    const t = setTimeout(() => {
      api.listRequests({ limit: PAGE, search: search.trim(), status: statusFilter, mine: mineOnly ? '1' : undefined }).then((res: any) => {
        if (cancelled) return;
        setError(null);
        if (Array.isArray(res)) { setRows(res); setHasMore(false); setTotal(res.length); }
        else { setRows(res.items); setHasMore(res.hasMore); setTotal(res.total ?? res.items.length); }
      }).catch((e) => { if (!cancelled) setError((e as Error).message); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, statusFilter, mineOnly, tick]);

  const loadMore = async () => {
    if (!rows || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.listRequests({ limit: PAGE, offset: rows.length, search: search.trim(), status: statusFilter, mine: mineOnly ? '1' : undefined }) as any;
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
            {me.permissions.includes('reports.view') && (
              <button
                aria-label="Экспорт в Excel (CSV)"
                onClick={async () => {
                  try {
                    const url = await api.exportRequestsUrl();
                    const link = document.createElement('a');
                    link.href = url; link.download = `zayavki-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
                    URL.revokeObjectURL(url);
                  } catch { alert('Не удалось выгрузить CSV'); }
                }}
                style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', cursor: 'pointer' }}
              >
                <Icon name="file" size={17} />
              </button>
            )}
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
          {/* №13: «Только мои» — сразу после «Все» */}
          <button
            onClick={() => setMineOnly((v) => !v)}
            style={{ padding: '9px 12px', fontSize: 12, fontWeight: 700, border: `1.5px solid ${mineOnly ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, background: mineOnly ? 'var(--accent-bg)' : 'var(--card)', color: mineOnly ? 'var(--accent)' : 'var(--fg2)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Только мои
          </button>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '9px 10px', fontSize: 12, border: '1.5px solid var(--border)', borderRadius: 10, background: 'var(--card)', color: 'var(--fg)', outline: 'none', appearance: 'none', cursor: 'pointer' }}
          >
            <option value="">Все</option>
            <option value="pending_approval">На согласовании</option>
            <option value="needs_revision">Возвращено на доработку</option>
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
            // Лист Excel №5: карточка «как раньше» — номер, статус, объект,
            // отдел снабжения и дата создания (а не наименование товара).
            const cf = r.customFields && typeof r.customFields === 'object' ? (r.customFields as Record<string, unknown>) : {};
            const obyekt = cf.obyekt != null && String(cf.obyekt).trim() !== '' ? String(cf.obyekt) : null;
            const dept = r.departmentNameResolved ?? r.departmentName ?? null;
            const cardRows: { k: string; v: string }[] = [];
            if (obyekt) cardRows.push({ k: 'Объект', v: obyekt });
            if (dept) cardRows.push({ k: 'Отдел снабжения', v: dept });
            cardRows.push({ k: 'Создана', v: r.createdAt ? fmtDate(r.createdAt) : '—' });
            return (
              <button
                key={r.id}
                onClick={() => onOpen(r.id)}
                style={{ textAlign: 'left', background: isMine ? 'var(--accent-bg)' : 'var(--card)', border: `1px solid ${isMine ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 15, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 11 }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: s.color }} />
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, color: 'var(--fg)', fontWeight: 600 }}>{r.requestNumber}</span>
                    {isMine && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent)', borderRadius: 6, padding: '2px 6px' }}>Создано мной</span>}
                  </div>
                  <StatusPill status={r.status} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {cardRows.map((cr) => (
                    <div key={cr.k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ fontSize: 12, color: 'var(--fg3)', fontWeight: 500, flex: 'none' }}>{cr.k}</span>
                      <span style={{ fontSize: 13, color: 'var(--fg)', fontWeight: 600, textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cr.v}</span>
                    </div>
                  ))}
                </div>
                {/* Сумму решает СЕРВЕР (getMoneyVisibility): null → скрыта. Клиентский
                    гейт по procurement.* прятал цену у директора/зам.дира (finance/audit). */}
                {r.estimatedAmount != null && <div style={{ fontSize: 12, color: 'var(--fg2)', fontFamily: "'IBM Plex Mono', monospace" }}>{money(r.estimatedAmount)} UZS</div>}
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

type DraftRequestItem = {
  materialId?: string | null;
  values: Record<string, string | boolean>;
  files: Record<string, { name: string; size: number; data: string }[]>;
};

type CatalogMaterial = {
  id: string;
  sku: string | null;
  name: string;
  nameUz: string | null;
  nameTr: string | null;
  defaultUnit: string | null;
};

const emptyRequestItem = (): DraftRequestItem => ({ values: {}, files: {} });

// Клик по любому месту поля даты открывает нативный date picker (а не только по
// иконке-календарю). showPicker() требует пользовательского жеста — onClick подходит.
const openDatePicker = (e: { currentTarget: HTMLInputElement & { showPicker?: () => void } }) => {
  if (e.currentTarget.type !== 'date') return;
  try { e.currentTarget.showPicker?.(); } catch { /* showPicker не поддержан — остаётся обычный фокус */ }
};

// ── Помощники превью (шаг «Проверьте заявку») ───────────────────────────────
const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);
// Черновые файлы позиции хранятся как base64 без префикса — собираем data-URL,
// mime берём по расширению (по умолчанию jpeg).
const fileDataUrl = (f: { name: string; data: string }) => {
  const ext = f.name.split('.').pop()?.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${f.data}`;
};
// Описание позиции — строки «Метка: значение»; строку «Вложения:» прячем (её
// заменяют миниатюры фото).
const parseDescRows = (desc?: string): { label: string; value: string }[] =>
  !desc
    ? []
    : desc
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('Вложения:'))
        .map((l) => {
          const i = l.indexOf(': ');
          return i > 0 ? { label: l.slice(0, i), value: l.slice(i + 2) } : { label: '', value: l };
        });

/** Create wizard rendered entirely from the admin-configured schema (/api/form/request_create). */
type DeptOption = { id: string; name: string; nameUz: string | null; nameTr: string | null; warehouseId?: string | null };
type ConfigUser = { id: string; fullName: string; departmentId?: string | null; departments?: DeptOption[] };

const userDepartmentLabel = (user: ConfigUser, lang: Lang): string => {
  const names = (user.departments ?? []).map((d) => localizedName(d, lang)).filter(Boolean);
  return names.length ? names.join(', ') : '';
};

const userOptionLabel = (user: ConfigUser, lang: Lang): string => {
  const dept = userDepartmentLabel(user, lang);
  return dept ? `${user.fullName} · ${dept}` : user.fullName;
};

const matchConfigUser = (users: ConfigUser[], value: unknown): ConfigUser | undefined => {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return users.find((u) => u.fullName === text || u.id === text);
};

function CreateRequest({ me, onDone, onCreated }: { me: Me; onDone: () => void; onCreated: (id: string) => void }) {
  const { lang } = useI18n();
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [unitTypes, setUnitTypes] = useState<DeptOption[]>([]);
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  const [configUsers, setConfigUsers] = useState<ConfigUser[]>([]);
  const [requesterId, setRequesterId] = useState(me.user.id);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [idx, setIdx] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [requestItems, setRequestItems] = useState<DraftRequestItem[]>([emptyRequestItem()]);
  const submitLock = useRef(false);
  const autoDepartmentRef = useRef<string>('');

  useEffect(() => {
    api
      .form('request_create')
      .then(async (f: { fields?: FormField[] }) => {
        let whs: { id: string; name: string }[] = [];
        let depts: DeptOption[] = [];
        let usrs: ConfigUser[] = [];
        let units: DeptOption[] = [];
        let mats: CatalogMaterial[] = [];
        try {
          const c = (await api.config()) as { warehouses?: { id: string; name: string }[]; departments?: DeptOption[]; users?: ConfigUser[] };
          whs = c.warehouses ?? [];
          depts = c.departments ?? [];
          usrs = c.users ?? [];
        } catch {
          /* config is optional */
        }
        try {
          const ut = (await api.unitTypes()) as { id: string; nameRu: string; nameUz: string | null; nameTr: string | null }[];
          units = ut.map((u) => ({ id: u.id, name: u.nameRu, nameUz: u.nameUz, nameTr: u.nameTr }));
        } catch {
          /* unit types are optional */
        }
        try {
          mats = (await api.materials()) as CatalogMaterial[];
        } catch {
          /* nomenclature autocomplete is optional */
        }
        const fs = Array.isArray(f.fields) ? f.fields : [];
        setFields(fs);
        setWarehouses(whs);
        setDepartments(depts);
        setUnitTypes(units);
        setMaterials(mats);
        setConfigUsers(usrs);
        const init: Record<string, string | boolean> = {};
        for (const fld of fs) {
          if (fld.type === 'checkbox') init[fld.key] = false;
          else if (fld.type === 'select') {
            const opts = fld.key === 'warehouse' ? whs.map((w) => ({ value: w.name, label: w.name })) : fld.options;
            init[fld.key] = fld.required && opts[0] ? opts[0].value : '';
          } else init[fld.key] = '';
        }
        let draft: { requesterId?: string; values?: Record<string, string | boolean>; requestItems?: DraftRequestItem[]; idx?: number } | null = null;
        try { draft = JSON.parse(sessionStorage.getItem(CREATE_DRAFT_KEY) || 'null'); } catch { draft = null; }
        if (draft) sessionStorage.removeItem(CREATE_DRAFT_KEY);
        const initialValues = draft?.values && typeof draft.values === 'object' ? { ...init, ...draft.values } : init;
        const initialRequesterId = draft?.requesterId && usrs.some((user) => user.id === draft?.requesterId)
          ? draft.requesterId
          : me.user.id;
        setRequesterId(initialRequesterId);
        const initialRequester = usrs.find((user) => user.id === initialRequesterId);
        const requesterDepartmentId = initialRequester?.departments?.[0]?.id ?? initialRequester?.departmentId ?? '';
        const defaultDepartmentId = requesterDepartmentId || (depts.length === 1 ? depts[0].id : '');
        if (!initialValues.department && defaultDepartmentId) {
          initialValues.department = defaultDepartmentId;
          autoDepartmentRef.current = defaultDepartmentId;
        }
        setValues(initialValues);
        if (Array.isArray(draft?.requestItems) && draft.requestItems.length > 0) setRequestItems(draft.requestItems);
        const draftIdx = draft?.idx;
        if (Number.isInteger(draftIdx)) setIdx(Math.max(0, Math.min(Number(draftIdx), fs.length)));
      })
      .catch((e) => setError((e as Error).message));
  }, [me.user.id]);

  useEffect(() => {
    const saveDraft = () => {
      sessionStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify({ requesterId, values, requestItems, idx }));
    };
    window.addEventListener(LANGUAGE_RELOAD_EVENT, saveDraft);
    return () => window.removeEventListener(LANGUAGE_RELOAD_EVENT, saveDraft);
  }, [requesterId, values, requestItems, idx]);

  const departmentWarehouseId = departments.find((department) => department.id === values.department)?.warehouseId ?? null;
  const departmentWarehouseName = warehouses.find((warehouse) => warehouse.id === departmentWarehouseId)?.name ?? '';
  useEffect(() => {
    if (!departmentWarehouseName) return;
    setRequestItems((previous) => {
      let changed = false;
      const next = previous.map((item) => {
        if (item.values.warehouse === departmentWarehouseName) return item;
        changed = true;
        return { ...item, values: { ...item.values, warehouse: departmentWarehouseName } };
      });
      return changed ? next : previous;
    });
  }, [departmentWarehouseName, requestItems.length]);

  const optionsFor = (f: FormField): { value: string; label: string; meta?: string }[] =>
    f.key === 'cf_department'
      ? departments.map((d) => ({ value: d.name, label: localizedName(d, lang) }))
      : f.key === 'department'
        ? departments.map((d) => ({ value: d.id, label: localizedName(d, lang) }))
      : f.key === 'cf_dept_head'
        ? configUsers.map((u) => ({ value: u.fullName, label: userOptionLabel(u, lang) }))
        : f.key === 'warehouse'
      ? warehouses.map((w) => ({ value: w.name, label: w.name }))
      : f.key === 'unit'
        ? unitTypes.map((u) => ({ value: u.name, label: localizedName(u, lang) }))
      : Array.isArray(f.options)
        ? f.options.map((o) => {
            const user = matchConfigUser(configUsers, o.value) ?? matchConfigUser(configUsers, o.label);
            return user ? { ...o, label: userOptionLabel(user, lang) } : o;
          })
        : [];
  const set = (key: string, v: string | boolean) => setValues((p) => {
    const next = { ...p, [key]: v };
    if (typeof v === 'string') {
      const picked = matchConfigUser(configUsers, v);
      const deptId = picked?.departments?.[0]?.id ?? picked?.departmentId ?? '';
      if (deptId && (!p.department || p.department === autoDepartmentRef.current)) {
        next.department = deptId;
        autoDepartmentRef.current = deptId;
      }
    }
    if (key === 'department' && v !== autoDepartmentRef.current) autoDepartmentRef.current = '';
    return next;
  });
  const selectRequester = (id: string) => {
    setRequesterId(id);
    const picked = configUsers.find((user) => user.id === id);
    const departmentId = picked?.departments?.[0]?.id ?? picked?.departmentId ?? '';
    setValues((previous) => ({ ...previous, department: departmentId }));
    autoDepartmentRef.current = departmentId;
  };

  const steps = fields ? [...new Set(fields.map((f) => f.step))].sort((a, b) => a - b) : [];
  const total = steps.length + 1; // field steps + review
  const onReview = fields !== null && idx === steps.length;
  const productStep = (fields ?? []).find((f) => f.system && f.key === 'itemName')?.step ?? null;
  const stepFieldsRaw = (s: number) => (fields ?? []).filter((f) => f.step === s);
  const movedToProductKeys = new Set(['warehouse', 'purpose', 'priority', 'neededDate', 'note', 'attachment']);
  const productFieldOrder = ['itemName', 'itemCode', 'quantity', 'unit', 'warehouse', 'purpose', 'priority', 'neededDate', 'note', 'attachment'];
  const stepFields = (s: number) =>
    stepFieldsRaw(s).filter((f) => {
      if (movedToProductKeys.has(f.key)) return false;
      return productStep == null || s !== productStep || f.key === 'itemName';
    });
  const productListEnabled = (fields ?? []).some((f) => f.system && f.key === 'itemName');
  const productFields = productFieldOrder
    .map((key) => (fields ?? []).find((f) => f.key === key))
    .filter(Boolean) as FormField[];
  const productFieldLabels = new Map(productFields.map((f) => [f.key, f.label]));
  const productOptionLabel = (key: string, value: unknown): string => {
    const f = productFields.find((x) => x.key === key);
    if (!f) return String(value ?? '');
    return optionsFor(f).find((o) => o.value === value)?.label ?? String(value ?? '');
  };
  const productDescription = (it: DraftRequestItem): string | undefined => {
    const lines: string[] = [];
    const push = (key: string, value: unknown, display?: string) => {
      if (value == null || value === '' || value === false) return;
      const label = productFieldLabels.get(key) ?? key;
      lines.push(`${label}: ${display ?? String(value)}`);
    };
    push('itemCode', it.values.itemCode);
    push('warehouse', it.values.warehouse, productOptionLabel('warehouse', it.values.warehouse));
    push('purpose', it.values.purpose, productOptionLabel('purpose', it.values.purpose));
    push('priority', it.values.priority, productOptionLabel('priority', it.values.priority));
    push('neededDate', it.values.neededDate);
    push('note', it.values.note);
    const files = Object.values(it.files).flat();
    if (files.length) lines.push(`Вложения: ${files.map((f) => f.name).join(', ')}`);
    return lines.length ? lines.join('\n') : undefined;
  };
  const normalizedDraftItems = () =>
    requestItems
      .map((it) => {
        const name = String(it.values.itemName ?? '').trim();
        return {
          name,
          materialId: it.materialId ?? null,
          quantity: Number(it.values.quantity) || 0,
          unit: String(it.values.unit ?? '').trim() || undefined,
          unitPrice: 0,
          description: productDescription(it),
        };
      })
      .filter((it) => it.name);
  const updateRequestItemValue = (index: number, key: string, value: string | boolean) => {
    setRequestItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, values: { ...it.values, [key]: value } } : it)),
    );
  };
  const normalizedCatalogValue = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase();
  const materialTitle = (material: CatalogMaterial) => localizedName(material, lang);
  const findMaterial = (key: string, value: string): CatalogMaterial | undefined => {
    const needle = normalizedCatalogValue(value);
    if (!needle) return undefined;
    return materials.find((material) => {
      if (key === 'itemCode') return normalizedCatalogValue(material.sku) === needle;
      return [material.name, material.nameUz, material.nameTr].some((title) => normalizedCatalogValue(title) === needle);
    });
  };
  const updateProductLookupValue = (index: number, key: string, value: string) => {
    const material = findMaterial(key, value);
    setRequestItems((prev) => prev.map((item, i) => {
      if (i !== index) return item;
      if (!material) return { ...item, materialId: null, values: { ...item.values, [key]: value } };
      return {
        ...item,
        materialId: material.id,
        values: {
          ...item.values,
          [key]: value,
          itemName: materialTitle(material),
          itemCode: material.sku ?? '',
          ...(material.defaultUnit ? { unit: material.defaultUnit } : {}),
        },
      };
    }));
  };
  const addRequestItemAfter = (index: number) => {
    setRequestItems((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, emptyRequestItem());
      return next;
    });
    setError(null);
  };
  const removeRequestItem = (index: number) => {
    setRequestItems((prev) => (prev.length === 1 ? [emptyRequestItem()] : prev.filter((_, i) => i !== index)));
  };
  const updateRequestItemFiles = (index: number, key: string, updater: (files: { name: string; size: number; data: string }[]) => { name: string; size: number; data: string }[]) => {
    setRequestItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, files: { ...it.files, [key]: updater(it.files[key] ?? []) } } : it)),
    );
  };

  const productFieldFilled = (f: FormField, item: DraftRequestItem): boolean => {
    const v = item.values[f.key];
    if ((f.type === 'select' || f.key === 'unit') && optionsFor(f).length === 0) return true;
    if (f.type === 'checkbox') return v === true;
    if (f.type === 'number') return Number(v) > 0;
    if (f.type === 'file') return (item.files[f.key] ?? []).length > 0;
    return String(v ?? '').trim().length > 0;
  };
  const filled = (f: FormField): boolean => {
    if (f.system && f.key === 'itemName') return !productListEnabled || normalizedDraftItems().length > 0;
    if (f.system && (f.key === 'quantity' || f.key === 'unit')) return true;
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
  // №5: атрибут min закрывает только пикер — руками прошлую дату всё ещё можно
  // впечатать. Валидируем значение и блокируем «Далее» (сервер дублирует).
  const todayISO = new Date().toISOString().slice(0, 10);
  const pastDate = (f: FormField): boolean => {
    if (f.type !== 'date') return false;
    const v = String(values[f.key] ?? '').trim();
    return v !== '' && v < todayISO;
  };
  const pastDates = stepFields(steps[idx] ?? -1).filter(pastDate);
  const onProductStep = productStep != null && steps[idx] === productStep;
  const productMissingRequired = onProductStep
    ? requestItems.flatMap((item, itemIndex) =>
        productFields
          .filter((f) => f.required && !productFieldFilled(f, item))
          .map((f) => `Позиция ${itemIndex + 1}: ${f.label}`),
      )
    : [];
  const productPastDates = onProductStep
    ? requestItems.flatMap((item, itemIndex) =>
        productFields
          .filter((f) => f.type === 'date' && String(item.values[f.key] ?? '').trim() !== '' && String(item.values[f.key] ?? '').trim() < todayISO)
          .map((f) => `Позиция ${itemIndex + 1}: ${f.label}`),
      )
    : [];

  const submit = async () => {
    if (submitLock.current) return;
    submitLock.current = true;
    setSaving(true);
    setError(null);
    try {
      const payload: CreateRequestData = { items: [] };
      payload.requesterId = requesterId;
      const custom: Record<string, unknown> = {};
      let firstText = '';
      for (const f of fields ?? []) {
        if (movedToProductKeys.has(f.key)) continue;
        if (productStep != null && f.step === productStep) continue;
        const v = values[f.key];
        const sval = typeof v === 'string' ? v.trim() : '';
        if (f.system) {
          switch (f.key) {
            case 'requestType': if (v) payload.requestType = String(v); break;
            // №7: заявка адресуется отделу — по departmentId её увидит нужный
            // руководитель отдела (роль с зоной ответственности этого отдела).
            case 'department': if (v) payload.departmentId = String(v); break;
            case 'warehouse': if (v) payload.warehouseName = String(v); break;
            case 'priority': if (v) payload.priority = String(v); break;
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
      const items = productListEnabled ? normalizedDraftItems() : [];
      const invalidItem = items.find((it) => !(it.quantity > 0));
      if (invalidItem) throw new Error('Укажите количество больше нуля для каждого продукта');
      const title = items[0]?.name || firstText;
      if (title) payload.title = title;
      // Product cards carry these values in the mobile wizard, while desktop
      // details read the canonical request-level fields.
      const neededDates = requestItems
        .map((item) => String(item.values.neededDate ?? '').trim())
        .filter(Boolean)
        .sort();
      if (neededDates[0]) payload.neededDate = neededDates[0];
      const warehouseName = requestItems
        .map((item) => String(item.values.warehouse ?? '').trim())
        .find(Boolean);
      if (warehouseName) payload.warehouseName = warehouseName;
      payload.items = items;
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
      for (const item of requestItems) {
        const itemName = String(item.values.itemName ?? '').trim();
        for (const files of Object.values(item.files)) {
          for (const file of files) {
            const filename = itemName ? `${itemName} - ${file.name}` : file.name;
            try { await api.attachments.upload(res.id, { filename, dataBase64: file.data }); } catch { /* best-effort */ }
          }
        }
      }
      // Макет 09.07: после отправки сразу открываем карточку заявки —
      // сверху полная информация, ниже процесс согласования.
      onCreated(res.id);
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
    if (f.type === 'file') {
      // Файлы лежат отдельно (__files_<key>), обычное значение поля всегда пусто —
      // без этой ветки в ревью у «Вложений» стоял «—» даже с прикреплёнными файлами.
      const files = ((values as any)['__files_' + f.key] ?? []) as { name: string }[];
      if (files.length === 0) return 'нет';
      const names = files.map((x) => x.name).join(', ');
      return names.length > 60 ? `${files.length} файл(ов)` : names;
    }
    return String(v ?? '').trim() || '—';
  };

  const renderField = (f: FormField) => {
    const optional = pastDate(f) ? (
      <span style={{ fontWeight: 600, color: 'var(--danger)' }}> — дата в прошлом, выберите сегодня или позже</span>
    ) : !f.required ? (
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
          <textarea value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder ?? ''} rows={3} style={{ ...input, minHeight: 92, resize: 'vertical', lineHeight: 1.45 }} />
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
    if (f.system && f.key === 'itemName') {
      const renderProductField = (pf: FormField, item: DraftRequestItem, itemIndex: number) => {
        const v = item.values[pf.key];
        const basePlaceholder = pf.key === 'neededDate' ? 'Ожидаемая дата получения' : pf.placeholder ?? pf.label;
        const isManagedSelect = pf.key === 'unit' || pf.type === 'select';
        // FIXES 2026-07-17: без префикса «Выберите:» — в плейсхолдере остаётся только название поля.
        const placeholder = isManagedSelect ? pf.label : basePlaceholder;
        if (isManagedSelect) {
          const opts = optionsFor(pf);
          return (
            <div style={{ position: 'relative' }}>
              <select
                aria-label={pf.label}
                value={String(v ?? '')}
                onChange={(e) => updateRequestItemValue(itemIndex, pf.key, e.target.value)}
                disabled={pf.key === 'warehouse' && !!departmentWarehouseId}
                style={{ ...input, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', cursor: 'pointer', color: v ? 'var(--fg)' : 'var(--fg3)', paddingRight: 40 }}
              >
                <option value="">{placeholder}</option>
                {opts.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}{o.meta ? ` · ${o.meta}` : ''}</option>
                ))}
              </select>
              <span style={{ position: 'absolute', right: 14, top: '50%', marginTop: -8, pointerEvents: 'none', color: 'var(--fg3)', transform: 'rotate(90deg)' }}>
                <Icon name="chev" size={16} sw={2.2} />
              </span>
            </div>
          );
        }
        if (pf.type === 'textarea') {
          return (
            <textarea
              aria-label={pf.label}
              value={String(v ?? '')}
              onChange={(e) => updateRequestItemValue(itemIndex, pf.key, e.target.value)}
              placeholder={placeholder}
              rows={3}
              style={{ ...input, minHeight: 92, resize: 'vertical', lineHeight: 1.45 }}
            />
          );
        }
        if (pf.type === 'file') {
          const files = item.files[pf.key] ?? [];
          return (
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, borderRadius: 12, border: '1.5px dashed var(--border)', background: 'var(--card2)', cursor: 'pointer' }}>
                <span style={{ width: 38, height: 38, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-bg)', color: 'var(--accent)' }}><Icon name="camera" size={20} /></span>
                <div style={{ fontSize: 13, color: files.length ? 'var(--fg)' : 'var(--fg3)', fontWeight: 600 }}>{files.length ? `${files.length} файл(ов) выбрано` : placeholder}</div>
                <input aria-label={pf.label} type="file" multiple style={{ display: 'none' }} onChange={(e) => {
                  const selected = e.target.files;
                  if (!selected) return;
                  const newFiles: { name: string; size: number; data: string }[] = [];
                  let pending = selected.length;
                  for (let x = 0; x < selected.length; x++) {
                    const file = selected[x];
                    if (file.size > 2 * 1024 * 1024) {
                      setError('Файл ' + file.name + ' больше 2 МБ');
                      pending--;
                      if (pending <= 0) updateRequestItemFiles(itemIndex, pf.key, (old) => [...old, ...newFiles]);
                      continue;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                      const base64 = (reader.result as string).split(',')[1] || '';
                      newFiles.push({ name: file.name, size: file.size, data: base64 });
                      pending--;
                      if (pending <= 0) updateRequestItemFiles(itemIndex, pf.key, (old) => [...old, ...newFiles]);
                    };
                    reader.readAsDataURL(file);
                  }
                }} />
              </label>
              {files.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {files.map((file, fileIndex) => (
                    <div key={fileIndex} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 8, background: 'var(--chip)', fontSize: 12 }}>
                      <span style={{ color: 'var(--fg)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{file.name}</span>
                      <button onClick={() => updateRequestItemFiles(itemIndex, pf.key, (old) => old.filter((_, j) => j !== fileIndex))} style={{ border: 'none', background: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: '2px 6px' }}>x</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (pf.type === 'date') {
          const hasValue = String(v ?? '').trim().length > 0;
          return (
            <div style={{ position: 'relative' }}>
              <input
                aria-label={pf.label}
                value={String(v ?? '')}
                onChange={(e) => updateRequestItemValue(itemIndex, pf.key, e.target.value)}
                onClick={openDatePicker}
                onFocus={openDatePicker}
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                style={{ ...input, color: hasValue ? 'var(--fg)' : 'transparent' }}
              />
              {!hasValue && (
                <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--fg3)', fontSize: 15, fontWeight: 500, background: 'var(--card)', paddingRight: 8 }}>
                  {placeholder}
                </span>
              )}
            </div>
          );
        }
        return (
          <>
            <input
              aria-label={pf.label}
              value={String(v ?? '')}
              onChange={(e) => {
                const value = pf.type === 'number' ? e.target.value.replace(/[^\d]/g, '') : e.target.value;
                if (pf.key === 'itemName' || pf.key === 'itemCode') updateProductLookupValue(itemIndex, pf.key, value);
                else updateRequestItemValue(itemIndex, pf.key, value);
              }}
              list={pf.key === 'itemName' ? `request-material-title-list-${itemIndex}` : pf.key === 'itemCode' ? `request-material-code-list-${itemIndex}` : undefined}
              autoComplete={pf.key === 'itemName' || pf.key === 'itemCode' ? 'off' : undefined}
              type="text"
              inputMode={pf.type === 'number' ? 'numeric' : undefined}
              placeholder={placeholder}
              style={{ ...input, fontFamily: pf.type === 'number' ? "'IBM Plex Mono', monospace" : input.fontFamily, color: String(v ?? '') ? 'var(--fg)' : 'var(--fg3)' }}
            />
            {pf.key === 'itemName' && (
              <datalist id={`request-material-title-list-${itemIndex}`}>
                {materials.map((material) => <option key={material.id} value={materialTitle(material)}>{material.sku ?? ''}</option>)}
              </datalist>
            )}
            {pf.key === 'itemCode' && (
              <datalist id={`request-material-code-list-${itemIndex}`}>
                {materials.filter((material) => material.sku).map((material) => <option key={material.id} value={material.sku ?? ''}>{materialTitle(material)}</option>)}
              </datalist>
            )}
          </>
        );
      };
      const renderProductFields = (item: DraftRequestItem, itemIndex: number) => {
        const rendered: ReactNode[] = [];
        for (let n = 0; n < productFields.length; n++) {
          const pf = productFields[n];
          if (pf.key === 'quantity') {
            const unitField = productFields.find((x) => x.key === 'unit');
            rendered.push(
              <div key="quantity-unit" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
                <div>{renderProductField(pf, item, itemIndex)}</div>
                {unitField && <div>{renderProductField(unitField, item, itemIndex)}</div>}
              </div>,
            );
            if (productFields[n + 1]?.key === 'unit') n++;
          } else if (pf.key === 'priority') {
            const dateField = productFields.find((x) => x.key === 'neededDate');
            rendered.push(
              <div key="priority-date" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
                <div>{renderProductField(pf, item, itemIndex)}</div>
                {dateField && <div>{renderProductField(dateField, item, itemIndex)}</div>}
              </div>,
            );
            if (productFields[n + 1]?.key === 'neededDate') n++;
          } else if (pf.key === 'neededDate') {
            continue;
          } else if (pf.key !== 'unit') {
            rendered.push(<div key={pf.key}>{renderProductField(pf, item, itemIndex)}</div>);
          }
        }
        return rendered;
      };
      return (
        <div>
          <div style={fieldLabel}>{f.label}{optional}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {requestItems.map((it, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 12, borderRadius: 12, background: 'var(--card)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Позиция {i + 1}</div>
                  {renderProductFields(it, i)}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <button
                    aria-label="Добавить продукт"
                    onClick={() => addRequestItemAfter(i)}
                    style={{ minHeight: 44, border: 'none', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'var(--accent-bg)', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                  >
                    <Icon name="plus" size={18} sw={2.4} />
                    Добавить
                  </button>
                  <button
                    aria-label="Удалить продукт"
                    onClick={() => removeRequestItem(i)}
                    style={{ minHeight: 44, border: 'none', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'var(--danger-bg)', color: 'var(--danger)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                  >
                    <Icon name="x" size={17} sw={2.4} />
                    Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (productStep != null && f.step === productStep) return null;
    if (f.type === 'number') {
      // №4: быстрый ввод количества — степпер −/+ и чипы популярных значений,
      // ручной ввод остаётся (колесо-пикер сознательно не делаем: для произвольных
      // количеств оно медленнее клавиатуры).
      const cur = Number(values[f.key]) || 0;
      const setNum = (n: number) => set(f.key, n > 0 ? String(Math.round(n)) : '');
      const stepBtn: CSSProperties = { flex: 'none', width: 52, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg)', fontSize: 22, fontWeight: 700, cursor: 'pointer' };
      return (
        <div>
          <label style={fieldLabel}>{f.label}{optional}</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
            <button aria-label="Минус" onClick={() => setNum(cur - 1)} style={stepBtn}>−</button>
            <input
              value={String(values[f.key] ?? '')}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d]/g, '');
                set(f.key, raw);
              }}
              type="text"
              inputMode="numeric"
              placeholder={f.placeholder ?? '0'}
              style={{ ...input, flex: 1, textAlign: 'center', fontFamily: "'IBM Plex Mono', monospace", fontSize: 17, fontWeight: 600 }}
            />
            <button aria-label="Плюс" onClick={() => setNum(cur + 1)} style={stepBtn}>+</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {[1, 5, 10, 50, 100, 500].map((n) => (
              <button key={n} onClick={() => setNum(n)} style={{ ...chip(cur === n), flex: 'none', fontFamily: "'IBM Plex Mono', monospace" }}>{n}</button>
            ))}
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
          onClick={openDatePicker}
          onFocus={openDatePicker}
          type={f.type === 'date' ? 'date' : 'text'}
          // №5: прошлые даты выбрать нельзя — минимум сегодня (сервер дублирует проверку).
          min={f.type === 'date' ? new Date().toISOString().slice(0, 10) : undefined}
          placeholder={f.placeholder ?? ''}
          style={input}
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

  const stepTitle = onReview ? 'Проверьте заявку' : `Шаг ${idx + 1}`;

  return (
    <div style={{ padding: '18px 20px 28px' }}>
      {(
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

      {!onReview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {stepFields(steps[idx]).map((f) => (
            <div key={f.key} style={{ display: 'contents' }}>
              <div>{renderField(f)}</div>
              {idx === 0 && f.key === 'requestType' && (
                <div>
                  <label htmlFor="request-requester" style={fieldLabel}>Заявитель</label>
                  <div style={{ position: 'relative' }}>
                    <select
                      id="request-requester"
                      value={requesterId}
                      onChange={(event) => selectRequester(event.target.value)}
                      style={{ ...input, appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', paddingRight: 38, cursor: 'pointer' }}
                    >
                      {configUsers.map((user) => (
                        <option key={user.id} value={user.id}>{userOptionLabel(user, lang)}</option>
                      ))}
                    </select>
                    <span style={{ position: 'absolute', right: 14, top: '50%', marginTop: -8, pointerEvents: 'none', color: 'var(--fg3)', display: 'inline-block', transform: 'rotate(90deg)' }}>
                      <Icon name="chev" size={16} sw={2.2} />
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {onReview && (() => {
        // Превью заявки = как она будет выглядеть в карточке: только заполненные
        // «общие» поля (без перенесённых в позиции и без пустых «—»), а сами
        // позиции — отдельными блоками с наименованием, количеством, деталями и фото.
        const selectedRequester = configUsers.find((user) => user.id === requesterId)
          ?? { id: me.user.id, fullName: me.user.fullName };
        const infoRows = [
          { label: 'Заявитель', value: userOptionLabel(selectedRequester, lang) },
          ...(fields ?? [])
          .filter((f) => f.key !== 'itemName' && !(productStep != null && f.step === productStep) && !movedToProductKeys.has(f.key))
          .map((f) => ({ label: f.label, value: displayValue(f) }))
          .filter((r) => r.value && r.value !== '—' && r.value !== 'нет'),
        ];
        const draftItems = requestItems.filter((it) => String(it.values.itemName ?? '').trim());
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={SECTION_LABEL}>Информация о заявке</div>
              {infoRows.length === 0 ? (
                <span style={{ fontSize: 13, color: 'var(--fg3)' }}>Нет данных</span>
              ) : (
                infoRows.map((r) => (
                  <div key={r.label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
                    <span style={{ fontSize: 14, color: 'var(--fg3)', fontWeight: 500, flex: 'none' }}>{r.label}</span>
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--fg)', textAlign: 'right', minWidth: 0 }}>{r.value}</span>
                  </div>
                ))
              )}
            </div>

            {draftItems.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
                <div style={SECTION_LABEL}>Позиции</div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {draftItems.map((it, idx) => {
                    const rows = parseDescRows(productDescription(it));
                    const photos = Object.values(it.files).flat().filter((f) => isImageName(f.name));
                    const name = String(it.values.itemName ?? '').trim();
                    const qty = String(it.values.quantity ?? '').trim();
                    const unit = String(it.values.unit ?? '').trim();
                    return (
                      <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>{name}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                            {/* Labels grey / values dark — same rule as the request detail view (7ac397c). */}
                            {qty && (
                              <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                                <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>Количество:</span>
                                <span style={{ fontWeight: 700, color: 'var(--fg)', fontFamily: "'IBM Plex Mono', monospace" }}>{qty}{unit ? ` ${unit}` : ''}</span>
                              </div>
                            )}
                            {rows.map((r, i) => (
                              <div key={i} style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                                {r.label && <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>{r.label}:</span>}
                                <span style={{ fontWeight: 700, color: 'var(--fg)', whiteSpace: 'pre-wrap', minWidth: 0 }}>{r.value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        {photos.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
                            {photos.map((p, i) => (
                              <img key={i} src={fileDataUrl(p)} alt={p.name} style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', flex: 'none' }} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {error && <Err>{error}</Err>}

      {!onReview && showErrors && (missingRequired.length > 0 || productMissingRequired.length > 0) && (
        <div style={{ marginTop: 16, borderRadius: 12, background: 'var(--danger-bg)', color: 'var(--danger)', padding: '12px 14px', fontSize: 13, lineHeight: 1.45 }}>
          Заполните обязательные поля: {[...missingRequired.map((f) => f.label), ...productMissingRequired].join(', ')}.
        </div>
      )}
      {!onReview && showErrors && productPastDates.length > 0 && (
        <div style={{ marginTop: 16, borderRadius: 12, background: 'var(--danger-bg)', color: 'var(--danger)', padding: '12px 14px', fontSize: 13, lineHeight: 1.45 }}>
          Дата ожидаемого получения не может быть в прошлом: {productPastDates.join(', ')}.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 18 }}>
        {idx === 0 && (
          <button onClick={onDone} style={{ flex: '0 0 auto', padding: '15px 22px', borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Отмена</button>
        )}
        {idx > 0 && (
          <button onClick={() => { setShowErrors(false); setIdx((i) => i - 1); }} style={{ flex: '0 0 auto', padding: '15px 22px', borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Назад</button>
        )}
        {!onReview && (
          <button
            onClick={() => {
              if (missingRequired.length === 0 && pastDates.length === 0 && productMissingRequired.length === 0 && productPastDates.length === 0) {
                setShowErrors(false);
                setIdx((i) => i + 1);
              } else {
                setShowErrors(true);
              }
            }}
            style={{ flex: 1, padding: 15, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: pastDates.length > 0 || productPastDates.length > 0 ? 0.6 : 1 }}
          >
            Далее
          </button>
        )}
        {onReview && (
          <button onClick={submit} disabled={saving} style={{ flex: 1, padding: 15, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}>{saving ? '…' : 'Создать заявку'}</button>
        )}
      </div>
    </div>
  );
}

function ImageThumb({ attachmentId, alt, size = 40 }: { attachmentId: string; alt: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    api.attachments.downloadUrl(attachmentId)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        objectUrl = u;
        setSrc(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);
  // Esc закрывает полноэкранный просмотр.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!src) return <span style={{ width: size, height: size, borderRadius: 8, flex: 'none', background: 'var(--skel)', display: 'block' }} />;
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        style={{ width: size, height: size, borderRadius: 8, flex: 'none', objectFit: 'cover', cursor: 'zoom-in' }}
      />
      {open && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out' }}
        >
          <img src={src} alt={alt} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10 }} />
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            aria-label="Закрыть"
            style={{ position: 'fixed', top: 16, right: 16, width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.15)', color: '#fff', fontSize: 20, fontWeight: 700, cursor: 'pointer', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>,
        document.body,
      )}
    </>
  );
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

  if (!atts || (atts.length === 0 && !uploading)) return null;

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
                  const url = await api.attachments.downloadUrl(a.id);
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
    return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
  const dmy = d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });
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
  const { t } = useI18n();
  const [req, setReq] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<LifecycleActionBtn | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Вложения тянем и здесь, чтобы показать фото рядом с каждой позицией: мастер
  // грузит их как вложения заявки с именем «<Позиция> - <файл>», по этому
  // префиксу и сопоставляем фото конкретной позиции.
  const [atts, setAtts] = useState<{ id: string; filename: string; mime: string | null; size: number }[]>([]);
  // #11 приёмка по позициям: фактически принятое количество на позицию (itemId → qty).
  const [itemReceipts, setItemReceipts] = useState<Record<string, string>>({});
  // Override учредителя/директора (approvals.override): причина + PIN.
  const [ovOpen, setOvOpen] = useState(false);
  const [ovReason, setOvReason] = useState('');
  const [ovPin, setOvPin] = useState('');
  const [ovBusy, setOvBusy] = useState(false);
  const actionLock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Silent refresh (keeps current view; also fires on the 30s tick, bug #6).
    api.getRequest(id)
      .then(data => { if (!cancelled) { setReq(data); setError(null); } })
      .catch(e => { if (!cancelled && !req) setError((e as Error).message); });
    api.attachments.list(id).then((a) => { if (!cancelled) setAtts(a); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tick]);

  const load = useCallback(() => {
    api.getRequest(id).then(setReq).catch((e) => setError((e as Error).message));
  }, [id]);

  const run = async (
    action: string,
    vals: { pin?: string; comment?: string; amount?: number; supplierName?: string; supplierId?: string; supplierPhone?: string; ndsIncluded?: boolean; paymentType?: string; quoteItems?: { itemId: string; unitPrice: number; supplierName?: string; supplierId?: string | null; ndsIncluded?: boolean; paymentType?: string | null }[]; leadTime?: string; quotationId?: string; assigneeId?: string } = {},
  ) => {
    if (actionLock.current) return;
    actionLock.current = true;
    try {
      setBusy(true);
      setError(null);
      const body: Parameters<typeof api.requestAction>[1] = { action, ...vals };
      // #11 приёмка частично/с расхождением — прикладываем принятое кол-во по позициям.
      if (action === 'receive_partial' || action === 'receive_discrepancy') {
        body.receipts = (req?.items ?? []).map((i) => ({
          itemId: i.id,
          receivedQty: Number(itemReceipts[i.id] ?? i.quantity),
        }));
      }
      const res = await api.requestAction(id, body);
      setPending(null);
      load();
      if (res?.warnings?.length && !WAREHOUSE_STOCK_ACTIONS.has(action)) {
        setError((res.warnings as string[]).join('\n'));
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
    setPending(a);
  };

  if (error && !req) return <div style={{ padding: 16 }}><Err>{error}</Err></div>;
  if (!req) return <div style={{ padding: 16 }}><Skeleton /></div>;

  const rawActions = req.actions ?? [];
  const actions = displayLifecycleActions(req.status, rawActions);
  // На складском шаге итоговое действие одно («Далее»), но наличие отмечается
  // по каждой позиции прямо в карточке продукта.
  const canMarkStock = req.status === 'warehouse_check' && rawActions.some((a) => a.action === 'wh_partial' || a.action === 'wh_in_stock');
  const canReceiveItems = req.status === 'receiving' && rawActions.some((a) => a.action.startsWith('receive_'));
  const markStock = async (itemId: string, inStock: boolean) => {
    try { await api.markItemStock(id, itemId, inStock); load(); } catch (e) { setError((e as Error).message); }
  };
  const warehouseStockActionFromItems = (): string | null => {
    const statuses = req.items.map((it) => it.status);
    const unmarked = statuses.some((s) => s !== 'in_stock' && s !== 'out_of_stock');
    if (unmarked) {
      setError('Отметьте наличие по каждой позиции перед нажатием «Далее».');
      return null;
    }
    if (statuses.every((s) => s === 'in_stock')) return 'wh_in_stock';
    if (statuses.every((s) => s === 'out_of_stock')) return 'wh_out_of_stock';
    return 'wh_partial';
  };
  const history = req.statusHistory ?? [];
  // КП фильтрует сервер (getMoneyVisibility) — согласующие после шага закупки
  // (напр. «Исп дир») видят их без procurement.*-прав.
  const quotations = req.quotations ?? [];

  // Bug #5: the author may cancel their own request while no one has approved yet.
  const TERMINAL = ['approved', 'closed', 'rejected', 'cancelled', 'archived'];
  const canCancel =
    req.requesterId === me.user.id &&
    !TERMINAL.includes(req.status) &&
    !(req.approvals ?? []).some((a) => a.status === 'approved');
  // FIXES 2026-07-20 (тест): override учредителя/директора — право
  // approvals.override теперь обслуживается основным API (эндпоинт портирован
  // из compat-слоя); кнопка видна держателям права на незавершённой заявке.
  const canOverride = me.permissions.includes('approvals.override') && !TERMINAL.includes(req.status);
  const doCancel = async () => {
    if (!(await confirmDialog('Удалить заявку? Отменить это действие будет нельзя.'))) return;
    try {
      await api.cancelRequest(id);
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const doOverride = async (action: 'approve' | 'cancel') => {
    setOvBusy(true);
    setError(null);
    try {
      await api.overrideRequest(id, { action, pin: ovPin, reason: ovReason.trim() });
      setOvOpen(false);
      setOvReason('');
      setOvPin('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOvBusy(false);
    }
  };

  // Full info (bug #9): show every meaningful field, not just status.
  const info: { k: string; v: string }[] = [];
  const pushInfo = (k: string, v: unknown) => { if (v != null && String(v).trim() !== '') info.push({ k, v: String(v) }); };
  pushInfo('Статус', req.statusLabel ?? statusMeta(req.status).label);
  pushInfo('Автор', req.requesterName);
  pushInfo('Завод', req.factoryName);
  pushInfo('Отдел', req.departmentNameResolved ?? req.departmentName);
  pushInfo('Склад', req.warehouseName);
  pushInfo('Ответственный', req.responsibleName);
  const ORDER_STATUS_LABEL: Record<string, string> = {
    started: 'Я начал',
    payment_in_progress: 'В процессе оплаты',
    delivery_in_progress: 'В процессе доставки',
    ordered: 'Заказ оформлен',
    sent: 'Заказ отправлен',
    delivered: 'Поставка доставлена',
    problem: 'Проблема',
  };
  pushInfo('Статус снабжения', req.orderStatus ? (ORDER_STATUS_LABEL[req.orderStatus] ?? req.orderStatus) : null);
  pushInfo('Нужно к', req.neededDate ? fmtDate(req.neededDate) : null);
  if (req.canSeeMoney && req.estimatedAmount != null) pushInfo('Сумма', `${Number(req.estimatedAmount).toLocaleString('ru-RU')} ${req.currency || 'UZS'}`);
  // Макет 09.07: при одной позиции — «Количество: 1 л»; при нескольких — счётчик.
  if (req.items.length === 1) pushInfo('Количество', `${req.items[0].quantity}${req.items[0].unit ? ' ' + req.items[0].unit : ''}`);
  else pushInfo('Позиций', String(req.items.length));
  // Кастомные поля (включая «Объект») — уже с подписями формы от сервера
  // (customInfo), не сырые ключи; блок «Дополнительно» больше не нужен.
  for (const ci of req.customInfo ?? []) pushInfo(ci.label, ci.value);

  // Фото позиции: мастер грузит вложения именем «<Позиция> - <файл>», по этому
  // префиксу и находим картинки конкретной позиции (mime может быть пуст —
  // тогда опираемся на расширение файла).
  const isImageAtt = (a: { mime: string | null; filename: string }) =>
    (a.mime?.startsWith('image/') ?? false) || /\.(png|jpe?g|gif|webp)$/i.test(a.filename);
  const itemPhotos = (name: string) => {
    const prefix = `${name.trim()} - `;
    return atts.filter((a) => isImageAtt(a) && a.filename.startsWith(prefix));
  };
  // Описание позиции хранится строками «Метка: значение» — разбираем их, чтобы
  // показать метку жирным, значение — обычным (строку «Вложения:» прячем, её
  // заменяют миниатюры фото справа).
  const parseItemRows = (desc?: string | null): { label: string; value: string }[] =>
    !desc
      ? []
      : desc
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('Вложения:'))
          .map((l) => {
            const i = l.indexOf(': ');
            return i > 0 ? { label: l.slice(0, i), value: l.slice(i + 2) } : { label: '', value: l };
          });

  return (
    <div style={{ padding: '16px 16px 28px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--fg2)', fontSize: 14, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
          ← Назад
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {req.canEdit && (
            <button onClick={() => setEditOpen(true)} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--fg2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 11px', borderRadius: 9 }}>
              Изменить
            </button>
          )}
          {canCancel && (
            <button onClick={doCancel} style={{ background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 11px', borderRadius: 9 }}>
              Удалить заявку
            </button>
          )}
          {canOverride && (
            <button onClick={() => setOvOpen((v) => !v)} style={{ background: 'none', border: '1px solid var(--warning)', color: 'var(--warning)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: '6px 11px', borderRadius: 9 }}>
              Override
            </button>
          )}
        </div>
      </div>

      {canOverride && ovOpen && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--warning)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--fg)' }}>Override — решение мимо оставшихся шагов</div>
          <textarea value={ovReason} onChange={(e) => setOvReason(e.target.value)} placeholder="Причина (обязательно)" style={{ width: '100%', minHeight: 56, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card2)', color: 'var(--fg)', fontSize: 13.5, fontFamily: 'inherit', resize: 'vertical' }} />
          <input value={ovPin} onChange={(e) => setOvPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="PIN" inputMode="numeric" style={{ width: 120, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--card2)', color: 'var(--fg)', fontSize: 14, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '.2em' }} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={ovBusy || !ovReason.trim() || ovPin.length < 4} onClick={() => doOverride('approve')} style={{ flex: 1, padding: 12, borderRadius: 10, border: 'none', background: 'var(--success)', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: ovBusy || !ovReason.trim() || ovPin.length < 4 ? 0.5 : 1 }}>Разрешить</button>
            <button disabled={ovBusy || !ovReason.trim() || ovPin.length < 4} onClick={() => doOverride('cancel')} style={{ flex: 1, padding: 12, borderRadius: 10, border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: ovBusy || !ovReason.trim() || ovPin.length < 4 ? 0.5 : 1 }}>Отклонить</button>
          </div>
        </div>
      )}

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: 'var(--fg2)', fontWeight: 500 }}>{req.requestNumber}</span>
          <StatusPill status={req.status} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 16 }}>
          {info.map((i) => (
            <div key={i.k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ fontSize: 14, color: 'var(--fg3)', fontWeight: 500, flex: 'none' }}>{i.k}</span>
              <span style={{ fontSize: 14.5, color: 'var(--fg)', fontWeight: 700, textAlign: 'right', minWidth: 0 }}>{i.v}</span>
            </div>
          ))}
        </div>
      </div>

      {req.description && String(req.description).trim() !== '' && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Примечание</div>
          <div style={{ fontSize: 13.5, color: 'var(--fg2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{req.description}</div>
        </div>
      )}

      {/* Позиции — сразу под шапкой, до прогресса согласования. Метки — secondary,
          значения — чёрные bold, фото каждой позиции — справа. */}
      {req.items.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Позиции</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {req.items.map((it) => {
              const rows = parseItemRows(it.description);
              const photos = itemPhotos(it.name);
              return (
                <div key={it.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    {/* 1) Наименование товара — заголовок позиции. */}
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)', overflowWrap: 'anywhere', lineHeight: 1.35 }}>{it.name}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                      {/* Detail rows intentionally match the creation preview. */}
                      <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                        <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>Количество:</span>
                        <span style={{ fontWeight: 700, color: 'var(--fg)', fontFamily: "'IBM Plex Mono', monospace" }}>{it.quantity}{it.unit ? ` ${it.unit}` : ''}</span>
                      </div>
                      {rows.map((r, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                          {r.label && <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>{r.label}:</span>}
                          <span style={{ fontWeight: 700, color: 'var(--fg)', whiteSpace: 'pre-wrap', minWidth: 0 }}>{r.value}</span>
                        </div>
                      ))}
                      {req.canSeeMoney && it.totalAmount != null && (
                        <>
                          {it.supplierName && (
                            <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                              <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>Поставщик:</span>
                              <span style={{ fontWeight: 700, color: 'var(--fg)', minWidth: 0 }}>{it.supplierName}</span>
                            </div>
                          )}
                          {(it.paymentType || it.ndsIncluded) && (
                            <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                              <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>Условия:</span>
                              <span style={{ fontWeight: 700, color: 'var(--fg)', minWidth: 0 }}>{[it.paymentType, it.ndsIncluded ? 'НДС' : null].filter(Boolean).join(' · ')}</span>
                            </div>
                          )}
                          {it.estimatedPrice != null && Number(it.estimatedPrice) > 0 && (
                            <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                              <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>Цена за 1:</span>
                              <span style={{ fontWeight: 700, color: 'var(--fg)', fontFamily: "'IBM Plex Mono', monospace" }}>{Number(it.estimatedPrice).toLocaleString('ru-RU')}</span>
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 6, fontSize: 13, lineHeight: 1.4 }}>
                            <span style={{ fontWeight: 500, color: 'var(--fg2)', flex: 'none' }}>Сумма:</span>
                            <span style={{ fontWeight: 700, color: 'var(--fg)', fontFamily: "'IBM Plex Mono', monospace" }}>{Number(it.totalAmount).toLocaleString('ru-RU')}</span>
                          </div>
                        </>
                      )}
                    </div>
                    {/* Действия/статус по каждому продукту (#3 наличие, #11 приёмка). */}
                    {(canMarkStock || canReceiveItems || it.status === 'in_stock' || it.status === 'out_of_stock' || Number(it.receivedQty) > 0) && (
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                        {it.status === 'in_stock' && !canMarkStock && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)' }}>✓ В наличии</span>}
                        {it.status === 'out_of_stock' && !canMarkStock && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--danger)' }}>✗ Нет — в закупку</span>}
                        {Number(it.receivedQty) > 0 && (
                          <span style={{ fontSize: 12, fontWeight: 700, color: Number(it.receivedQty) < Number(it.quantity) ? 'var(--warning)' : 'var(--success)' }}>
                            Принято {Number(it.receivedQty)} из {it.quantity}
                          </span>
                        )}
                        {canMarkStock && (
                          <>
                            <button onClick={() => markStock(it.id, true)} disabled={busy} style={{ fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 12px', borderRadius: 9, border: `1.5px solid ${it.status === 'in_stock' ? 'var(--success)' : 'var(--border)'}`, background: it.status === 'in_stock' ? 'var(--success-bg)' : 'var(--card)', color: it.status === 'in_stock' ? 'var(--success)' : 'var(--fg2)' }}>В наличии</button>
                            <button onClick={() => markStock(it.id, false)} disabled={busy} style={{ fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: '6px 12px', borderRadius: 9, border: `1.5px solid ${it.status === 'out_of_stock' ? 'var(--danger)' : 'var(--border)'}`, background: it.status === 'out_of_stock' ? 'var(--danger-bg)' : 'var(--card)', color: it.status === 'out_of_stock' ? 'var(--danger)' : 'var(--fg2)' }}>Нет</button>
                          </>
                        )}
                        {canReceiveItems && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg2)' }}>
                            Принято:
                            <input type="number" min={0} value={itemReceipts[it.id] ?? String(it.quantity)} onChange={(e) => setItemReceipts((p) => ({ ...p, [it.id]: e.target.value }))} style={{ width: 72, padding: '5px 8px', fontSize: 13, border: '1.5px solid var(--border)', borderRadius: 8, background: 'var(--card)', color: 'var(--fg)' }} />
                            <span style={{ color: 'var(--fg3)' }}>из {it.quantity}{it.unit ? ` ${it.unit}` : ''}</span>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                  {photos.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
                      {photos.map((p) => (
                        <ImageThumb key={p.id} attachmentId={p.id} alt={p.filename} size={64} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <AttachmentsSection requestId={id} />

      {/* Задача Сарвара 09.07: примечание/позиции/вложения — часть информации
          о заявке и стоят ВЫШЕ процесса согласования (#10 timeline после них,
          per-step actor/date-time #7, rejected-состояние #4). */}
      {(req.workflowTimeline ?? []).length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>Процесс согласования</div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {(req.workflowTimeline ?? []).map((step, idx, arr) => {
              const last = idx === arr.length - 1;
              const done = step.state === 'completed';
              const cur = step.state === 'current';
              const rej = step.state === 'rejected';
              // Лист Excel №13: возврат на доработку — шаг «Отменено» серым.
              const cancelled = step.state === 'cancelled';
              // FIXES 2026-07-17 (лист E): шаг, вернувший заявку автору, — оранжевый
              // «Возвращено на доработку», с автором и комментарием причины.
              const ret = step.state === 'returned';
              const color = rej ? 'var(--danger)' : ret ? 'var(--warning)' : done ? 'var(--success)' : cur ? 'var(--warning)' : 'var(--fg3)';
              const mark = rej ? '✕' : ret ? '↩' : cancelled ? '✕' : done ? '✓' : cur ? '●' : '';
              const lineColor = rej ? 'var(--danger)' : step.state === 'future' || cancelled ? 'var(--line)' : color;
              return (
                <div key={step.stepId ?? idx} style={{ display: 'flex', gap: 13 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', marginTop: 2, flex: 'none', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff', fontWeight: 700 }}>{mark}</span>
                    {!last && <span style={{ width: 2, flex: 1, minHeight: 26, background: lineColor }} />}
                  </div>
                  <div style={{ paddingBottom: 16, flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: step.state === 'future' || cancelled ? 'var(--fg3)' : 'var(--fg)' }}>{step.stepName}</div>
                    <div style={{ fontSize: 11.5, marginTop: 2, fontWeight: cur || rej || ret ? 600 : 500, color: rej ? 'var(--danger)' : ret || cur ? 'var(--warning)' : done ? 'var(--success)' : 'var(--fg3)' }}>
                      {step.action === 'created' ? 'Создана' : rej ? 'Отклонено' : ret ? 'Возвращено на доработку' : cancelled ? 'Отменено' : done ? 'Согласовано' : cur ? 'Текущий этап · ожидает' : 'Ожидает'}
                    </div>
                    {(step.actorName || step.at) && (
                      <div style={{ fontSize: 11, color: 'var(--fg3)', marginTop: 3, fontFamily: "'IBM Plex Mono', monospace" }}>
                        {step.actorName ?? ''}{step.actorRole ? ` · ${step.actorRole}` : ''}{step.at ? ` · ${fmtDateTime(step.at)}` : ''}
                      </div>
                    )}
                    {step.comment && (rej || ret) && (
                      <div style={{ fontSize: 12, color: rej ? 'var(--danger)' : 'var(--warning)', marginTop: 4, lineHeight: 1.4 }}>
                        Комментарий: {step.comment}
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
                  {(q.paymentType || q.ndsIncluded) && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>{[q.paymentType, q.ndsIncluded ? 'НДС 12%' : null].filter(Boolean).join(' · ')}</div>}
                  {q.leadTime && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>срок: {q.leadTime}</div>}
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700, color: 'var(--fg)', flex: 'none' }}>{q.amount.toLocaleString('ru-RU')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* №12в: история — только ролям с audit.view (сервер отдаёт её лишь им),
          зато подробная: переходы статусов, источник, плюс полный аудит-лог. */}
      {history.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadowSm)', padding: 16 }}>
          <div style={SECTION_LABEL}>История действий (аудит)</div>
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
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>
                      {h.oldStatus ? `${statusMeta(h.oldStatus).label} → ` : ''}{m.label}
                    </div>
                    {h.changedByName && (
                      <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>
                        {h.changedByName}
                        {h.changedByRole ? ` · ${h.changedByRole}` : ''}
                      </div>
                    )}
                    {h.comment && <div style={{ fontSize: 12, color: 'var(--fg2)', marginTop: 2 }}>{h.comment}</div>}
                    <div style={{ fontSize: 11, color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>
                      {fmtDateTime(h.createdAt)}{(h as any).source ? ` · ${(h as any).source}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {((req as any).auditTrail ?? []).length > 0 && (
            <>
              <div style={{ ...SECTION_LABEL, marginTop: 14 }}>Аудит-лог</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {((req as any).auditTrail as any[]).map((t) => (
                  <div key={t.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--fg)', fontFamily: "'IBM Plex Mono', monospace" }}>{t.action}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg2)', marginTop: 2 }}>
                      {t.userName ?? 'система'} · {t.module}{t.source ? ` · ${t.source}` : ''} · {fmtDateTime(t.createdAt)}
                    </div>
                    {(t.oldValue || t.newValue) && (
                      <div style={{ fontSize: 10.5, color: 'var(--fg3)', fontFamily: "'IBM Plex Mono', monospace", marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {t.oldValue ? `− ${JSON.stringify(t.oldValue)}\n` : ''}{t.newValue ? `+ ${JSON.stringify(t.newValue)}` : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {error && <Err>{error}</Err>}

      {actions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {actions.map((a) => (
            <button key={a.action} onClick={() => onAction(a)} disabled={busy} style={{ ...actionBtnStyle(a.action), opacity: busy ? 0.5 : 1 }}>
              {ACTION_LABEL_KEYS[a.action] ? t(ACTION_LABEL_KEYS[a.action]) : a.label}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <ActionModal
          action={pending}
          requestId={id}
          requesterId={req.requesterId}
          busy={busy}
          error={error}
          quotations={quotations}
          items={req.items}
          onCancel={() => { setPending(null); setError(null); }}
          onConfirm={(vals) => {
            const action = pending.action === 'wh_in_stock' && req.status === 'warehouse_check'
              ? warehouseStockActionFromItems()
              : pending.action;
            if (!action) return;
            run(action, vals).catch(() => {});
          }}
        />
      )}

      {editOpen && (
        <EditRequestSheet
          req={req}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); load(); }}
        />
      )}
    </div>
  );
}

/** Правка заявки автором (или requests.edit) на ранних этапах — в т.ч. сценарий
 *  «на доработке»: поправить поля перед «Отправить повторно». Кнопка появляется
 *  только по canEdit из ответа сервера; состав полей = принимаемым PUT /requests/:id. */
function EditRequestSheet({ req, onClose, onSaved }: { req: RequestDetail; onClose: () => void; onSaved: () => void }) {
  const { lang } = useI18n();
  const cf0 = req.customFields && typeof req.customFields === 'object' ? (req.customFields as Record<string, unknown>) : {};
  // Лист Excel №1: полная правка — тип, отдел и настраиваемые поля (объект, место закупа).
  const [requestType, setRequestType] = useState(req.requestType ?? '');
  const [departmentId, setDepartmentId] = useState(req.departmentId ?? '');
  const [customValues, setCustomValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [k, v] of Object.entries(cf0)) init[k] = v == null ? '' : String(v);
    return init;
  });
  type EditDraftItem = DraftRequestItem & { id?: string; unitPrice?: number };
  const baseEditItems = (req.items.length ? req.items : [{ id: '', name: '', quantity: '1', unit: '', description: '', estimatedPrice: null }]).map((it): EditDraftItem => ({
    id: it.id,
    unitPrice: it.estimatedPrice ?? undefined,
    values: {
      itemName: it.name ?? '',
      quantity: String(it.quantity ?? '1'),
      unit: it.unit ?? '',
      note: it.description ?? '',
    },
    files: {},
  }));
  const [itemEdits, setItemEdits] = useState<EditDraftItem[]>(baseEditItems);
  // Настраиваемые (non-system) select-поля из конструктора формы + список отделов.
  const [customFieldDefs, setCustomFieldDefs] = useState<FormField[]>([]);
  const [productFieldDefs, setProductFieldDefs] = useState<FormField[]>([]);
  const [typeOptions, setTypeOptions] = useState<{ value: string; label: string }[]>([]);
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  const [unitTypes, setUnitTypes] = useState<DeptOption[]>([]);
  const [configUsers, setConfigUsers] = useState<ConfigUser[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const autoDepartmentRef = useRef<string>('');

  useEffect(() => {
    api.form('request_create').then(async (f: { fields?: FormField[] }) => {
      let whs: { id: string; name: string }[] = [];
      let depts: DeptOption[] = [];
      let usrs: ConfigUser[] = [];
      let units: DeptOption[] = [];
      try {
        const c = (await api.config()) as { warehouses?: { id: string; name: string }[]; departments?: DeptOption[]; users?: ConfigUser[] };
        whs = c.warehouses ?? [];
        depts = c.departments ?? [];
        usrs = c.users ?? [];
      } catch {
        /* config is optional */
      }
      try {
        const ut = (await api.unitTypes()) as { id: string; nameRu: string; nameUz: string | null; nameTr: string | null }[];
        units = ut.map((u) => ({ id: u.id, name: u.nameRu, nameUz: u.nameUz, nameTr: u.nameTr }));
      } catch {
        /* unit types are optional */
      }
      const fs = Array.isArray(f.fields) ? f.fields : [];
      const PRODUCT_LEVEL = new Set(['warehouse', 'purpose', 'priority', 'neededDate', 'note', 'attachment']);
      setCustomFieldDefs(fs.filter((x) => !x.system && !PRODUCT_LEVEL.has(x.key) && Array.isArray(x.options) && x.options.length > 0));
      const order = ['itemName', 'itemCode', 'quantity', 'unit', 'warehouse', 'purpose', 'priority', 'neededDate', 'note', 'attachment'];
      const pfs = order.map((key) => fs.find((x) => x.key === key)).filter(Boolean) as FormField[];
      setProductFieldDefs(pfs);
      setWarehouses(whs);
      setDepartments(depts);
      setUnitTypes(units);
      setConfigUsers(usrs);
      const optionsForLoaded = (field: FormField) =>
        field.key === 'warehouse'
          ? whs.map((w) => ({ value: w.name, label: w.name }))
          : field.key === 'cf_dept_head'
            ? usrs.map((u) => ({ value: u.fullName, label: userOptionLabel(u, lang) }))
            : field.key === 'unit'
              ? units.map((u) => ({ value: u.name, label: u.name }))
            : Array.isArray(field.options)
              ? field.options.map((o) => {
                  const user = matchConfigUser(usrs, o.value) ?? matchConfigUser(usrs, o.label);
                  return user ? { ...o, label: userOptionLabel(user, lang) } : o;
                })
              : [];
      setItemEdits(baseEditItems.map((item, itemIndex) => {
        const source = req.items[itemIndex];
        const values: Record<string, string | boolean> = { ...item.values };
        const unmatched: string[] = [];
        for (const rawLine of String(source?.description ?? '').split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('Вложения:')) continue;
          const split = line.indexOf(': ');
          if (split <= 0) {
            unmatched.push(line);
            continue;
          }
          const label = line.slice(0, split);
          const value = line.slice(split + 2);
          const field = pfs.find((pf) => pf.label === label || pf.key === label);
          if (!field || ['itemName', 'quantity', 'unit', 'attachment'].includes(field.key)) {
            unmatched.push(line);
            continue;
          }
          if (field.type === 'select') {
            const opt = optionsForLoaded(field).find((o) => o.label === value || o.value === value);
            values[field.key] = opt?.value ?? value;
          } else {
            values[field.key] = value;
          }
        }
        if (unmatched.length && !values.note) values.note = unmatched.join('\n');
        return { ...item, values };
      }));
      const rt = fs.find((x) => x.system && x.key === 'requestType');
      if (rt && Array.isArray(rt.options)) setTypeOptions(rt.options.map((o) => ({ value: o.value, label: o.label })));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputStyle: CSSProperties = { width: '100%', padding: '12px 14px', fontSize: 14, border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none' };
  const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 6 };
  const optionsForEdit = (f: FormField): { value: string; label: string; meta?: string }[] =>
    f.key === 'cf_department'
      ? departments.map((d) => ({ value: d.name, label: localizedName(d, lang) }))
      : f.key === 'department'
        ? departments.map((d) => ({ value: d.id, label: localizedName(d, lang) }))
        : f.key === 'cf_dept_head'
          ? configUsers.map((u) => ({ value: u.fullName, label: userOptionLabel(u, lang) }))
          : f.key === 'warehouse'
            ? warehouses.map((w) => ({ value: w.name, label: w.name }))
            : f.key === 'unit'
              ? unitTypes.map((u) => ({ value: u.name, label: localizedName(u, lang) }))
            : Array.isArray(f.options)
              ? f.options.map((o) => {
                  const user = matchConfigUser(configUsers, o.value) ?? matchConfigUser(configUsers, o.label);
                  return user ? { ...o, label: userOptionLabel(user, lang) } : o;
                })
              : [];
  const setItemEdit = (index: number, key: string, value: string | boolean) => {
    setItemEdits((prev) => prev.map((it, i) => (i === index ? { ...it, values: { ...it.values, [key]: value } } : it)));
  };
  const setCustomValue = (key: string, value: string) => {
    setCustomValues((p) => ({ ...p, [key]: value }));
    const picked = matchConfigUser(configUsers, value);
    const deptId = picked?.departments?.[0]?.id ?? picked?.departmentId ?? '';
    if (deptId && (!departmentId || departmentId === autoDepartmentRef.current)) {
      setDepartmentId(deptId);
      autoDepartmentRef.current = deptId;
    }
  };
  const addItemEdit = (index: number) => {
    setItemEdits((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, { id: '', values: { quantity: '1' }, files: {}, unitPrice: undefined });
      return next;
    });
  };
  const removeItemEdit = (index: number) => {
    setItemEdits((prev) => (prev.length === 1 ? [{ id: '', values: { quantity: '1' }, files: {}, unitPrice: undefined }] : prev.filter((_, i) => i !== index)));
  };
  const updateItemFiles = (index: number, key: string, updater: (files: { name: string; size: number; data: string }[]) => { name: string; size: number; data: string }[]) => {
    setItemEdits((prev) => prev.map((it, i) => (i === index ? { ...it, files: { ...it.files, [key]: updater(it.files[key] ?? []) } } : it)));
  };
  const productOptionLabelEdit = (key: string, value: unknown): string => {
    const f = productFieldDefs.find((x) => x.key === key);
    if (!f) return String(value ?? '');
    return optionsForEdit(f).find((o) => o.value === value)?.label ?? String(value ?? '');
  };
  const productDescriptionEdit = (it: EditDraftItem): string | undefined => {
    const labels = new Map(productFieldDefs.map((f) => [f.key, f.label]));
    const lines: string[] = [];
    const push = (key: string, value: unknown, display?: string) => {
      if (value == null || value === '' || value === false) return;
      lines.push(`${labels.get(key) ?? key}: ${display ?? String(value)}`);
    };
    push('itemCode', it.values.itemCode);
    push('warehouse', it.values.warehouse, productOptionLabelEdit('warehouse', it.values.warehouse));
    push('purpose', it.values.purpose, productOptionLabelEdit('purpose', it.values.purpose));
    push('priority', it.values.priority, productOptionLabelEdit('priority', it.values.priority));
    push('neededDate', it.values.neededDate);
    push('note', it.values.note);
    const files = Object.values(it.files).flat();
    if (files.length) lines.push(`Вложения: ${files.map((f) => f.name).join(', ')}`);
    return lines.length ? lines.join('\n') : undefined;
  };
  const normalizedItemEdits = () =>
    itemEdits
      .map((it) => ({
        id: it.id || undefined,
        name: String(it.values.itemName ?? '').trim(),
        quantity: Number(it.values.quantity),
        unit: String(it.values.unit ?? '').trim() || undefined,
        description: productDescriptionEdit(it),
        unitPrice: it.unitPrice,
      }))
      .filter((it) => it.name);
  const renderEditProductField = (pf: FormField, item: EditDraftItem, itemIndex: number) => {
    const v = item.values[pf.key];
    const isManagedSelect = pf.key === 'unit' || pf.type === 'select';
    const placeholder = isManagedSelect ? pf.label : pf.key === 'neededDate' ? 'Ожидаемая дата получения' : pf.placeholder ?? pf.label;
    if (isManagedSelect) {
      const opts = optionsForEdit(pf);
      return (
        <div style={{ position: 'relative' }}>
          <select aria-label={pf.label} value={String(v ?? '')} onChange={(e) => setItemEdit(itemIndex, pf.key, e.target.value)} style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none', color: v ? 'var(--fg)' : 'var(--fg3)', paddingRight: 38 }}>
            <option value="">{placeholder}</option>
            {opts.map((o) => <option key={o.value} value={o.value}>{o.label}{o.meta ? ` · ${o.meta}` : ''}</option>)}
          </select>
          <span style={{ position: 'absolute', right: 14, top: '50%', marginTop: -8, pointerEvents: 'none', color: 'var(--fg3)', transform: 'rotate(90deg)' }}><Icon name="chev" size={16} sw={2.2} /></span>
        </div>
      );
    }
    if (pf.type === 'textarea') {
      return <textarea aria-label={pf.label} value={String(v ?? '')} onChange={(e) => setItemEdit(itemIndex, pf.key, e.target.value)} placeholder={placeholder} rows={3} style={{ ...inputStyle, minHeight: 92, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }} />;
    }
    if (pf.type === 'date') {
      const hasValue = String(v ?? '').trim().length > 0;
      return (
        <div style={{ position: 'relative' }}>
          <input aria-label={pf.label} value={String(v ?? '')} onChange={(e) => setItemEdit(itemIndex, pf.key, e.target.value)} onClick={openDatePicker} onFocus={openDatePicker} type="date" min={new Date().toISOString().slice(0, 10)} style={{ ...inputStyle, color: hasValue ? 'var(--fg)' : 'transparent' }} />
          {!hasValue && <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--fg3)', fontSize: 14, background: 'var(--card)', paddingRight: 8 }}>{placeholder}</span>}
        </div>
      );
    }
    if (pf.type === 'file') {
      const files = item.files[pf.key] ?? [];
      return (
        <div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 13, borderRadius: 11, border: '1.5px dashed var(--border)', background: 'var(--card2)', cursor: 'pointer' }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-bg)', color: 'var(--accent)' }}><Icon name="camera" size={19} /></span>
            <div style={{ fontSize: 13, color: files.length ? 'var(--fg)' : 'var(--fg3)', fontWeight: 600 }}>{files.length ? `${files.length} файл(ов) выбрано` : placeholder}</div>
            <input aria-label={pf.label} type="file" multiple style={{ display: 'none' }} onChange={(e) => {
              const selected = e.target.files;
              if (!selected) return;
              const newFiles: { name: string; size: number; data: string }[] = [];
              let pending = selected.length;
              for (let x = 0; x < selected.length; x++) {
                const file = selected[x];
                if (file.size > 2 * 1024 * 1024) {
                  setMsg('Файл ' + file.name + ' больше 2 МБ');
                  pending--;
                  if (pending <= 0) updateItemFiles(itemIndex, pf.key, (old) => [...old, ...newFiles]);
                  continue;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1] || '';
                  newFiles.push({ name: file.name, size: file.size, data: base64 });
                  pending--;
                  if (pending <= 0) updateItemFiles(itemIndex, pf.key, (old) => [...old, ...newFiles]);
                };
                reader.readAsDataURL(file);
              }
            }} />
          </label>
          {files.length > 0 && <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>{files.map((file, fileIndex) => (
            <div key={fileIndex} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 8, background: 'var(--chip)', fontSize: 12 }}>
              <span style={{ color: 'var(--fg)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{file.name}</span>
              <button onClick={() => updateItemFiles(itemIndex, pf.key, (old) => old.filter((_, j) => j !== fileIndex))} style={{ border: 'none', background: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: '2px 6px' }}>x</button>
            </div>
          ))}</div>}
        </div>
      );
    }
    return <input aria-label={pf.label} value={String(v ?? '')} onChange={(e) => setItemEdit(itemIndex, pf.key, pf.type === 'number' ? e.target.value.replace(/[^\d.]/g, '') : e.target.value)} inputMode={pf.type === 'number' ? 'decimal' : undefined} placeholder={placeholder} style={{ ...inputStyle, fontFamily: pf.type === 'number' ? "'IBM Plex Mono', monospace" : undefined, color: String(v ?? '') ? 'var(--fg)' : 'var(--fg3)' }} />;
  };
  const renderEditProductFields = (item: EditDraftItem, itemIndex: number) => {
    const fields = productFieldDefs.length > 0
      ? productFieldDefs
      : [
          { key: 'itemName', label: 'Наименование', type: 'text', system: true, required: true, placeholder: 'Название продукта', options: [], step: 1 },
          { key: 'quantity', label: 'Количество', type: 'number', system: true, required: true, placeholder: '0', options: [], step: 1 },
          { key: 'unit', label: 'Ед. изм.', type: 'select', system: true, required: false, placeholder: 'Ед. изм.', options: [], step: 1 },
          { key: 'note', label: 'Примечание', type: 'textarea', system: true, required: false, placeholder: 'Назначение, склад, срочность, примечания...', options: [], step: 1 },
        ] as FormField[];
    const rendered: ReactNode[] = [];
    for (let n = 0; n < fields.length; n++) {
      const pf = fields[n];
      if (pf.key === 'quantity') {
        const unitField = fields.find((x) => x.key === 'unit');
        rendered.push(<div key="quantity-unit" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}><div>{renderEditProductField(pf, item, itemIndex)}</div>{unitField && <div>{renderEditProductField(unitField, item, itemIndex)}</div>}</div>);
        if (fields[n + 1]?.key === 'unit') n++;
      } else if (pf.key === 'priority') {
        const dateField = fields.find((x) => x.key === 'neededDate');
        rendered.push(<div key="priority-date" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}><div>{renderEditProductField(pf, item, itemIndex)}</div>{dateField && <div>{renderEditProductField(dateField, item, itemIndex)}</div>}</div>);
        if (fields[n + 1]?.key === 'neededDate') n++;
      } else if (pf.key === 'neededDate' || pf.key === 'unit') {
        continue;
      } else {
        rendered.push(<div key={pf.key}>{renderEditProductField(pf, item, itemIndex)}</div>);
      }
    }
    return rendered;
  };

  const save = async () => {
    try {
      setSaving(true);
      setMsg(null);
      // Отправляем только те настраиваемые поля, что есть в конструкторе (+ уже
      // заданные ранее), чтобы не потерять значения, которых нет среди select-ов.
      const cfPayload: Record<string, unknown> = { ...customValues };
      const itemsPayload = normalizedItemEdits();
      if (itemsPayload.length === 0) throw new Error('Добавьте хотя бы один продукт');
      if (itemsPayload.some((it) => !Number.isFinite(it.quantity) || it.quantity <= 0)) {
        throw new Error('Укажите количество больше нуля для каждого продукта');
      }
      await api.updateRequest(req.id, {
        title: itemsPayload[0]?.name ?? req.title ?? '',
        requestType: requestType || undefined,
        departmentId: departmentId || null,
        customFields: cfPayload,
        items: itemsPayload,
      });
      for (const item of itemEdits) {
        const itemName = String(item.values.itemName ?? '').trim();
        for (const files of Object.values(item.files)) {
          for (const file of files) {
            const filename = itemName ? `${itemName} - ${file.name}` : file.name;
            try { await api.attachments.upload(req.id, { filename, dataBase64: file.data }); } catch { /* best-effort */ }
          }
        }
      }
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>Изменить заявку</div>
        {typeOptions.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Тип заявки</div>
            <select value={requestType} onChange={(e) => setRequestType(e.target.value)} style={inputStyle}>
              {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}
        {departments.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Отдел</div>
            <select value={departmentId} onChange={(e) => { autoDepartmentRef.current = ''; setDepartmentId(e.target.value); }} style={inputStyle}>
              <option value="">— не выбран —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{localizedName(d, lang)}</option>)}
            </select>
          </div>
        )}
        {customFieldDefs.map((f) => (
          <div key={f.key} style={{ marginBottom: 12 }}>
            <div style={labelStyle}>{f.key === 'origin' ? 'Место закупа' : f.label}</div>
            <select value={customValues[f.key] ?? ''} onChange={(e) => setCustomValue(f.key, e.target.value)} style={inputStyle}>
              <option value="">— не выбрано —</option>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        ))}
        <div style={{ marginTop: 18, marginBottom: 12 }}>
          <div style={{ ...labelStyle, marginBottom: 10 }}>Продукты</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {itemEdits.map((it, i) => (
              <div key={`${it.id || 'new'}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--card)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Позиция {i + 1}</div>
                {renderEditProductFields(it, i)}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <button onClick={() => addItemEdit(i)} style={{ minHeight: 40, border: 'none', borderRadius: 10, background: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Добавить</button>
                  <button onClick={() => removeItemEdit(i)} style={{ minHeight: 40, border: 'none', borderRadius: 10, background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Удалить</button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--danger)' }}>{msg}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Закрыть</button>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: 14, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.5 : 1 }}>{saving ? '…' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  );
}

function ActionModal({
  action,
  requestId,
  requesterId,
  busy,
  error,
  quotations,
  items,
  onCancel,
  onConfirm,
}: {
  action: LifecycleActionBtn;
  requestId: string;
  requesterId?: string;
  busy: boolean;
  error: string | null;
  quotations: QuotationRow[];
  items: DetailItem[];
  onCancel: () => void;
  onConfirm: (vals: { pin?: string; comment?: string; amount?: number; supplierName?: string; supplierId?: string; supplierPhone?: string; ndsIncluded?: boolean; paymentType?: string; quoteItems?: { itemId: string; unitPrice: number; supplierName?: string; supplierId?: string | null; ndsIncluded?: boolean; paymentType?: string | null }[]; leadTime?: string; quotationId?: string; assigneeId?: string }) => void;
}) {
  const { t } = useI18n();
  const [comment, setComment] = useState('');
  // Bug #3: role-based rejection reasons + «Другое» → free text.
  // Пресеты причин — для отклонений И возвратов (директор/исп.дир/снабжение выбирают причину).
  const isReject = action.action === 'reject' || action.action.startsWith('reject_') || action.action.startsWith('return_');
  const [reasons, setReasons] = useState<string[]>([]);
  const [reasonChoice, setReasonChoice] = useState('');
  useEffect(() => {
    // FIXES 2026-07-17 (лист G): у «Пересмотреть цену» свой список причин — передаём action.
    if (isReject) api.rejectReasons(requestId, action.action).then((r: any) => setReasons(r?.reasons ?? [])).catch(() => setReasons([]));
  }, [isReject, requestId, action.action]);
  const OTHER = '__other__';

  // Bug #8: procurement head assigns a specific снабженец.
  const isAssign = !!action.assign;
  const [assignees, setAssignees] = useState<{ id: string; fullName: string | null }[]>([]);
  const [assigneeId, setAssigneeId] = useState('');
  useEffect(() => {
    if (isAssign) {
      api.procurementAssignees()
        .then((r) => setAssignees((r?.users ?? []).filter((u) => u.id !== requesterId && u.fullName !== 'Учредитель' && u.fullName !== 'Руководитель снабжения')))
        .catch(() => setAssignees([]));
    }
  }, [isAssign, requesterId]);
  const [amount, setAmount] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
  const [paymentTypes, setPaymentTypes] = useState<string[]>([]);
  const [itemPaymentTypes, setItemPaymentTypes] = useState<Record<string, string>>(() => Object.fromEntries(items.map((it) => [it.id, it.paymentType ?? ''])));
  const [itemNds, setItemNds] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((it) => [it.id, !!it.ndsIncluded])));
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>(() => Object.fromEntries(items.map((it) => [it.id, it.estimatedPrice != null && it.estimatedPrice > 0 ? String(it.estimatedPrice) : ''])));
  const [leadTime, setLeadTime] = useState('');
  const [quotationId, setQuotationId] = useState(quotations.find((q) => q.selected)?.id ?? '');
  const isAdd = action.quote === 'add';
  const isSelect = action.quote === 'select';
  useEffect(() => {
    if (isAdd) {
      api.procurement.settings().then((r) => {
        const opts = r.paymentTypes ?? [];
        setPaymentTypes(opts);
        if (opts.length > 0) {
          setItemPaymentTypes((prev) => Object.fromEntries(items.map((it) => [it.id, prev[it.id] || opts[0]])));
        }
      }).catch(() => setPaymentTypes([]));
    }
  }, [isAdd, items]);
  const inputStyle: CSSProperties = { width: '100%', padding: '13px 15px', fontSize: 15, border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none', fontFamily: "'IBM Plex Sans', system-ui, sans-serif" };
  const lbl: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--fg2)', marginBottom: 8 };
  const quoteLines = items.map((it) => {
    const unitPrice = Number(unitPrices[it.id] || 0);
    const base = Number(it.quantity) * unitPrice;
    return { item: it, unitPrice, supplierId: null, supplierName: supplierName.trim(), ndsIncluded: !!itemNds[it.id], paymentType: itemPaymentTypes[it.id] || '', total: Math.round(base) };
  });
  const quoteTotal = quoteLines.reduce((sum, l) => sum + l.total, 0);
  // Effective reject comment: chosen preset, or free text when «Другое».
  const effectiveComment = isReject && reasons.length > 0
    ? (reasonChoice === OTHER ? comment.trim() : reasonChoice)
    : comment.trim();
  const ok =
    (!action.comment || effectiveComment.length > 0) &&
    (!action.amount || isAdd || (amount !== '' && Number(amount) > 0)) &&
    (!isAdd || (supplierName.trim().length > 0 && supplierPhone.replace(/\D/g, '').length >= 7 && quoteLines.length > 0 && quoteLines.every((l) => Number.isFinite(l.unitPrice) && l.unitPrice > 0 && l.paymentType.trim().length > 0) && quoteTotal > 0)) &&
    (!isSelect || quotationId !== '') &&
    (!isAssign || assigneeId !== '');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={onCancel} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>{ACTION_LABEL_KEYS[action.action] ? t(ACTION_LABEL_KEYS[action.action]) : action.label}</div>
        {isAssign && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>{t('proc.assignee')}</div>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={inputStyle}>
              <option value="" disabled>{t('proc.selectAssignee')}</option>
              {assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName || a.id}</option>)}
            </select>
            {assignees.length === 0 && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 6 }}>{t('proc.noAssignees')}</div>}
          </div>
        )}
        {isAdd && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="quote-supplier-name" style={lbl}>{t('proc.supplierName')}</label>
              <input id="quote-supplier-name" value={supplierName} onChange={(e) => setSupplierName(e.target.value)} autoComplete="organization" placeholder={t('proc.supplierNamePlaceholder')} style={inputStyle} />
              <label htmlFor="quote-supplier-phone" style={{ ...lbl, marginTop: 8 }}>{t('proc.supplierPhone')}</label>
              <input id="quote-supplier-phone" value={supplierPhone} onChange={(e) => setSupplierPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="+998 90 123 45 67" style={inputStyle} />
              <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--fg3)', marginTop: 6 }}>{t('proc.supplierPhoneHint')}</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>{t('proc.itemPrices')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {quoteLines.map(({ item, total }) => (
                  <div key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 11, background: 'var(--card)', padding: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--fg)', overflowWrap: 'anywhere', lineHeight: 1.3 }}>{item.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>{Number(item.quantity)}{item.unit ? ` ${item.unit}` : ''}</div>
                      </div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 700, color: 'var(--fg)', flex: 'none' }}>{total.toLocaleString('ru-RU')}</div>
                    </div>
                    <input
                      value={unitPrices[item.id] ?? ''}
                      onChange={(e) => setUnitPrices((prev) => ({ ...prev, [item.id]: e.target.value.replace(/[^\d.]/g, '') }))}
                      inputMode="decimal"
                      placeholder={t('proc.unitPrice')}
                      style={{ ...inputStyle, padding: '10px 12px', fontFamily: "'IBM Plex Mono', monospace" }}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 118px', gap: 8, marginTop: 8 }}>
                      <select
                        value={itemPaymentTypes[item.id] ?? ''}
                        onChange={(e) => setItemPaymentTypes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        style={{ ...inputStyle, padding: '10px 12px' }}
                      >
                        <option value="" disabled>{t('proc.selectPaymentType')}</option>
                        {(paymentTypes.length ? paymentTypes : ['Перечисление', 'Наличные']).map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>
                      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 42, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer' }}>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--fg)' }}>НДС</span>
                        <input type="checkbox" checked={!!itemNds[item.id]} onChange={(e) => setItemNds((prev) => ({ ...prev, [item.id]: e.target.checked }))} />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 12, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '12px 13px', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{t('proc.total')}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 16, fontWeight: 800 }}>{quoteTotal.toLocaleString('ru-RU')} UZS</span>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={lbl}>{t('proc.leadTime')}</div>
              <input value={leadTime} onChange={(e) => setLeadTime(e.target.value)} placeholder={t('proc.leadTimePlaceholder')} style={inputStyle} />
            </div>
          </>
        )}
        {isSelect && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>{t('proc.chooseQuotation')}</div>
            {quotations.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--fg3)', padding: '8px 0' }}>{t('proc.addQuotationFirst')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {quotations.map((q) => {
                  const sel = quotationId === q.id;
                  return (
                    <button key={q.id} onClick={() => setQuotationId(q.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 13px', borderRadius: 11, border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--border)'}`, background: sel ? 'var(--accent-bg)' : 'var(--card)', cursor: 'pointer', textAlign: 'left' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>{q.supplierName}</div>
                        {(q.paymentType || q.ndsIncluded) && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>{[q.paymentType, q.ndsIncluded ? t('proc.nds') : null].filter(Boolean).join(' · ')}</div>}
                        {q.leadTime && <div style={{ fontSize: 12, color: 'var(--fg3)', marginTop: 2 }}>{t('proc.deliveryTerm')}: {q.leadTime}</div>}
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
            <div style={lbl}>{t('reject.reason')}</div>
            <select value={reasonChoice} onChange={(e) => setReasonChoice(e.target.value)} style={inputStyle}>
              <option value="" disabled>{t('reject.selectReason')}</option>
              {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value={OTHER}>{t('reject.other')}</option>
            </select>
            {reasonChoice === OTHER && (
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder={t('reject.commentPlaceholder')} style={{ ...inputStyle, resize: 'none', lineHeight: 1.45, marginTop: 8 }} />
            )}
          </div>
        )}
        {action.comment && !(isReject && reasons.length > 0) && (
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>{t('common.comment')}</div>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder={t('common.commentPlaceholder')} style={{ ...inputStyle, resize: 'none', lineHeight: 1.45 }} />
          </div>
        )}
        {error && <Err>{error}</Err>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>{t('common.cancel')}</button>
          <button
            onClick={() =>
              onConfirm({
                pin: undefined,
                comment: action.comment ? effectiveComment : undefined,
                amount: isAdd ? quoteTotal : (action.amount ? Number(amount) : undefined),
                supplierName: isAdd ? supplierName.trim() : undefined,
                supplierPhone: isAdd ? supplierPhone.trim() : undefined,
                ndsIncluded: isAdd ? quoteLines.some((l) => l.ndsIncluded) : undefined,
                paymentType: isAdd ? (() => {
                  const types = [...new Set(quoteLines.map((l) => l.paymentType).filter(Boolean))];
                  if (types.length === 1) return types[0];
                  if (types.length > 1) return 'По позициям';
                  return undefined;
                })() : undefined,
                quoteItems: isAdd ? quoteLines.map((l) => ({ itemId: l.item.id, unitPrice: l.unitPrice, supplierName: l.supplierName, supplierId: l.supplierId, ndsIncluded: l.ndsIncluded, paymentType: l.paymentType })) : undefined,
                leadTime: isAdd && leadTime.trim() ? leadTime.trim() : undefined,
                quotationId: isSelect ? quotationId : undefined,
                assigneeId: isAssign ? assigneeId : undefined,
              })
            }
            disabled={busy || !ok}
            style={{ flex: 1, padding: 14, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: busy || !ok ? 'not-allowed' : 'pointer', opacity: busy || !ok ? 0.5 : 1 }}
          >
            {busy ? t('common.loading') : t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small UI bits ────────────────────────────────────────────────────────────
interface DevUser {
  username: string;
  phone: string | null;
  fullName: string;
  roles: string[];
}

/** Test-mode switch: pin THIS WINDOW to a test user via `?phone=` (boot re-logins). */
function switchTestUser(user: DevUser): void {
  const params = new URLSearchParams();
  params.set(user.phone ? 'phone' : 'user', user.phone ?? user.username);
  window.location.href = '/?' + params.toString();
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
              onClick={() => switchTestUser(u)}
              disabled={u.username === current || u.phone === current}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4, borderRadius: 10, border: 'none', cursor: u.username === current || u.phone === current ? 'default' : 'pointer', background: u.username === current || u.phone === current ? '#7c3aed' : 'rgba(127,127,127,.14)', color: u.username === current || u.phone === current ? '#fff' : 'inherit' }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>{u.fullName}</div>
              <div style={{ fontSize: 11, opacity: 0.72 }}>{u.phone ? `+${u.phone} · ` : ''}{u.username} · {u.roles.join(', ')}</div>
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
          Telegram ichida odatiy kirish. Test muhitida — telefon yoki test login orqali kirish.
        </p>
        {testUsers && testUsers.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-center text-[11px] font-bold uppercase tracking-wider text-fg3">Тестовые пользователи</div>
            {testUsers.map((u) => (
              <button
                key={u.username}
                onClick={() => switchTestUser(u)}
                className="mb-1 w-full rounded-xl border border-line bg-card px-3.5 py-2 text-left active:scale-[.98]"
              >
                <div className="text-[13px] font-semibold text-fg">{u.fullName}</div>
                <div className="text-[11px] text-fg3">{u.phone ? `+${u.phone} · ` : ''}{u.username} · {u.roles.join(', ')}</div>
              </button>
            ))}
          </div>
        )}
        <input
          value={tgId}
          onChange={(e) => setTgId(e.target.value)}
          placeholder="Telefon yoki test login"
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
