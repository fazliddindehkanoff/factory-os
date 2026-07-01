/** Light/dark theme, persisted. Light is the design's default; dark is the alternate. */
export type Theme = 'light' | 'dark';

const KEY = 'factoryos.theme';

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  localStorage.setItem(KEY, t);
}
