import { useState } from 'react';
import { api, setToken } from '../api';
import { Err, Centered } from './shared';

export function DevLogin({ error, onLoggedIn }: { error: string | null; onLoggedIn: () => void }) {
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
        <div className="mb-1 text-center text-2xl font-bold tracking-tight text-fg">Factory OS</div>
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
