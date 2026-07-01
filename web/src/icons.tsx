/**
 * Icon set ported 1:1 from the confirmed design (public/index.html ICONS map).
 * Stroke icons on a 24×24 grid; color follows `currentColor`.
 */
const PATHS: Record<string, string[]> = {
  home: ['M3 10.8 12 3.2l9 7.6', 'M5.5 9.3V19a1.2 1.2 0 0 0 1.2 1.2H9.5v-5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V20.2h2.8A1.2 1.2 0 0 0 18.5 19V9.3'],
  file: ['M6.5 2.5h7l4.5 4.5V21a.5 .5 0 0 1-.5.5H6.5A.5 .5 0 0 1 6 21V3a.5 .5 0 0 1 .5-.5Z', 'M13.5 2.5V7H18', 'M9 12.5h6', 'M9 16h6'],
  checkCircle: ['M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19Z', 'M8 12l2.8 2.8L16 9'],
  box: ['M12 2.6 3.5 7v10L12 21.4 20.5 17V7Z', 'M3.7 7.2 12 11.6l8.3-4.4', 'M12 11.6v9.8'],
  grid: ['M4.5 4.5h6v6h-6z', 'M13.5 4.5h6v6h-6z', 'M4.5 13.5h6v6h-6z', 'M13.5 13.5h6v6h-6z'],
  bell: ['M6 9.5a6 6 0 0 1 12 0c0 4.5 1.8 5.8 1.8 5.8H4.2S6 14 6 9.5Z', 'M10 19a2 2 0 0 0 4 0'],
  back: ['M14.5 5 8 12l6.5 7'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 3v2', 'M12 19v2', 'M5 12H3', 'M21 12h-2', 'M5.6 5.6 7 7', 'M17 17l1.4 1.4', 'M18.4 5.6 17 7', 'M7 17l-1.4 1.4'],
  moon: ['M20.5 13.2A8 8 0 1 1 10.8 3.5a6.5 6.5 0 0 0 9.7 9.7Z'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M19.5 19.5 15.6 15.6'],
  check: ['M5 12.5 10 17.5 19.5 6.5'],
  upload: ['M12 15.5V4', 'M7.5 8.5 12 4l4.5 4.5', 'M5 20h14'],
  camera: ['M4.5 8.5h3l1.6-2.6h5.8L16.5 8.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z', 'M12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  chev: ['M9.5 5 16 12l-6.5 7'],
  robot: ['M6.5 8.5h11a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 16.5V10a1.5 1.5 0 0 1 1.5-1.5Z', 'M12 4.5v4', 'M9.5 13h.01', 'M14.5 13h.01', 'M9.8 16.3h4.4', 'M3.2 12v3', 'M20.8 12v3'],
  wallet: ['M3.5 7.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z', 'M15.5 13h3.5', 'M3.5 7.5 14.5 4l2.2 3.3'],
  alert: ['M12 3.6 21 19.4H3Z', 'M12 10v4.2', 'M12 17.4h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.5V12l3 1.8'],
  x: ['M6.5 6.5 17.5 17.5', 'M17.5 6.5 6.5 17.5'],
  mappin: ['M12 21.5s6.5-5.2 6.5-11A6.5 6.5 0 0 0 5.5 10.5c0 5.8 6.5 11 6.5 11Z', 'M12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z'],
  siren: ['M6.5 20h11', 'M8 20v-6a4 4 0 0 1 8 0v6', 'M12 5.5V3.5', 'M18.5 8 20 6.5', 'M5.5 8 4 6.5', 'M19.5 13.5H21', 'M3 13.5h1.5'],
  truck: ['M3.5 7h9v9h-9z', 'M12.5 10h4l3 3v3h-7z', 'M7 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M16.5 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'],
  wrench: ['M14.7 6.3a3.5 3.5 0 0 0-4.6 4.3l-6 6L7 19.6l6-6a3.5 3.5 0 0 0 4.3-4.6l-2.2 2.2-2-2Z'],
  gear: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z', 'M19 12c0-.5 0-1-.1-1.4l1.7-1.3-1.7-2.9-2 .8a6.7 6.7 0 0 0-2.4-1.4L14.2 4H9.8l-.3 1.8a6.7 6.7 0 0 0-2.4 1.4l-2-.8L3.4 9.3l1.7 1.3c0 .4-.1.9-.1 1.4s0 1 .1 1.4l-1.7 1.3 1.7 2.9 2-.8a6.7 6.7 0 0 0 2.4 1.4l.3 1.8h4.4l.3-1.8a6.7 6.7 0 0 0 2.4-1.4l2 .8 1.7-2.9-1.7-1.3c.1-.4.1-.9.1-1.4Z'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M3 12h18', 'M12 3c2.5 2.5 3.5 6 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-6-3.5-9s1-6.5 3.5-9Z'],
  shield: ['M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z'],
  logout: ['M9 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h3', 'M14 8l4 4-4 4', 'M18 12H9'],
};

export function Icon({ name, size = 22, sw = 1.9 }: { name: string; size?: number; sw?: number }) {
  const ds = PATHS[name] ?? [];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      {ds.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** Tint name → foreground / background CSS variable (theme-reactive). */
export const TINT_FG: Record<string, string> = {
  accent: 'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
};
export const TINT_BG: Record<string, string> = {
  accent: 'var(--accent-bg)',
  success: 'var(--success-bg)',
  warning: 'var(--warning-bg)',
  danger: 'var(--danger-bg)',
};
