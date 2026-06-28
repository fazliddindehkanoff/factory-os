import { useState, type CSSProperties } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { roleLabel, type Me } from './shared';
import type { Theme } from '../theme';

export function Menu({ me, theme, onToggleTheme, onLogout }: { me: Me; theme: Theme; onToggleTheme: () => void; onLogout: () => void }) {
  const rowStyle: CSSProperties = {
    width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: '14px 15px', border: 'none',
    borderTop: '1px solid var(--line)', background: 'none', cursor: 'pointer', textAlign: 'left',
  };
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savePin = async () => {
    setSaving(true); setPinMsg(null);
    try { await api.setPin(pin); setPinMsg('PIN сохранён'); setPin(''); }
    catch (e) { setPinMsg((e as Error).message); }
    finally { setSaving(false); }
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
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Тема оформления</span>
          <span style={{ fontSize: 13, color: 'var(--fg2)' }}>{theme === 'dark' ? 'Тёмная' : 'Светлая'}</span>
        </button>
        <button onClick={() => { setPinOpen(true); setPinMsg(null); }} style={rowStyle}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--accent-bg)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="shield" size={19} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>PIN для подписи</span>
          <span style={{ color: 'var(--fg3)' }}><Icon name="chev" size={16} sw={2.2} /></span>
        </button>
        <button onClick={onLogout} style={rowStyle}>
          <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, background: 'var(--danger-bg)', color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="logout" size={19} /></span>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--danger)' }}>Выйти</span>
        </button>
      </div>
      {pinOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={() => setPinOpen(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
          <div style={{ position: 'relative', width: '100%', maxWidth: 560, background: 'var(--bg)', borderTop: '1px solid var(--edge)', borderRadius: '24px 24px 0 0', padding: '20px 20px 28px' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--fg)', marginBottom: 6 }}>PIN для подписи</div>
            <div style={{ fontSize: 13, color: 'var(--fg2)', marginBottom: 16, lineHeight: 1.45 }}>4-8 цифр. Нужен для согласования и других действий с подписью.</div>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" type="password" placeholder="••••" style={{ width: '100%', padding: '13px 15px', fontSize: 18, letterSpacing: 6, textAlign: 'center', border: '1.5px solid var(--border)', borderRadius: 11, background: 'var(--card)', color: 'var(--fg)', outline: 'none' }} />
            {pinMsg && <div style={{ marginTop: 10, fontSize: 13, color: pinMsg.includes('сохранён') ? 'var(--success)' : 'var(--danger)' }}>{pinMsg}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setPinOpen(false)} style={{ flex: 1, padding: 14, borderRadius: 11, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--fg2)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Закрыть</button>
              <button onClick={savePin} disabled={saving || pin.length < 4} style={{ flex: 1, padding: 14, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: saving || pin.length < 4 ? 'not-allowed' : 'pointer', opacity: saving || pin.length < 4 ? 0.5 : 1 }}>{saving ? '...' : 'Сохранить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
