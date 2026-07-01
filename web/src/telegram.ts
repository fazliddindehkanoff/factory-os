interface TgWebApp {
  initData: string;
  ready?: () => void;
  expand?: () => void;
  showConfirm?: (message: string, callback: (ok: boolean) => void) => void;
  BackButton: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  MainButton: {
    show: () => void;
    hide: () => void;
    setText: (text: string) => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
}

export function getTelegram(): TgWebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: TgWebApp } };
  return w.Telegram?.WebApp ?? null;
}

/**
 * Confirmation that works inside Telegram (native window.confirm is often
 * suppressed in the in-app browser). Uses tg.showConfirm when available,
 * falls back to window.confirm outside Telegram.
 */
export function confirmDialog(message: string): Promise<boolean> {
  const tg = getTelegram();
  if (tg?.showConfirm) {
    return new Promise((resolve) => tg.showConfirm!(message, (ok) => resolve(!!ok)));
  }
  return Promise.resolve(window.confirm(message));
}
