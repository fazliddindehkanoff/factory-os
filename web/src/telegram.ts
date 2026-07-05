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
 * telegram-web-app.js создаёт window.Telegram.WebApp и в обычном браузере,
 * поэтому «метод существует» ≠ «метод можно звать»: вне Telegram (или в старом
 * клиенте) showConfirm/showAlert бросают WebAppMethodUnsupported. Настоящий
 * Telegram-контекст отличаем по непустому initData, а сам вызов страхуем
 * try/catch с откатом на window.confirm/alert.
 */
function insideTelegram(tg: TgWebApp | null): tg is TgWebApp {
  return !!tg && !!tg.initData;
}

/**
 * Confirmation that works inside Telegram (native window.confirm is often
 * suppressed in the in-app browser). Uses tg.showConfirm when available,
 * falls back to window.confirm outside Telegram.
 */
export function confirmDialog(message: string): Promise<boolean> {
  const tg = getTelegram();
  if (insideTelegram(tg) && tg.showConfirm) {
    return new Promise((resolve) => {
      try {
        tg.showConfirm!(message, (ok) => resolve(!!ok));
      } catch {
        resolve(window.confirm(message));
      }
    });
  }
  return Promise.resolve(window.confirm(message));
}

/** Alert с тем же контрактом: Telegram-попап внутри Telegram, window.alert иначе. */
export function alertDialog(message: string): void {
  const tg = getTelegram() as (TgWebApp & { showAlert?: (m: string) => void }) | null;
  if (insideTelegram(tg) && tg.showAlert) {
    try {
      tg.showAlert(message);
      return;
    } catch {
      /* упасть в window.alert ниже */
    }
  }
  window.alert(message);
}
