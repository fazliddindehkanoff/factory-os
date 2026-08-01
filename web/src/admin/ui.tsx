/** Shared admin UI primitives — match the dark/IBM-Plex design language of App.tsx. */
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TouchEvent as ReactTouchEvent,
} from 'react';

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg2">{children}</div>;
}

export function Err({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-xl bg-danger/15 px-3 py-2.5 text-sm text-danger">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-edge px-4 py-10 text-center text-sm text-fg3">
      {children}
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[64px] animate-pulse rounded-2xl bg-card" />
      ))}
    </div>
  );
}

type Tone = 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'system';
const TONE: Record<Tone, string> = {
  muted: 'bg-fg3/20 text-fg2',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  system: 'bg-white/5 text-fg2',
};

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

export function Field({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={`w-full rounded-xl border border-line bg-card px-3.5 py-2.5 text-sm text-fg outline-none placeholder:text-fg3 focus:border-accent ${className ?? ''}`}
    />
  );
}

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      {...p}
      className={`w-full appearance-none rounded-xl border border-line bg-card px-3.5 py-2.5 text-sm text-fg outline-none focus:border-accent ${className ?? ''}`}
    >
      {children}
    </select>
  );
}

export function PrimaryBtn({ className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-accent/20 active:scale-95 disabled:opacity-50 ${className ?? ''}`}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-xl bg-white/5 px-4 py-2.5 text-sm font-semibold text-fg2 active:scale-95 disabled:opacity-50 ${className ?? ''}`}
    >
      {children}
    </button>
  );
}

/** Tiny inline icon-ish button (rename/delete/etc.). */
export function MiniBtn({ className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-lg px-2 py-1 text-xs font-semibold active:scale-95 ${className ?? 'bg-white/5 text-fg2'}`}
    >
      {children}
    </button>
  );
}

/**
 * Bottom sheet: slides up, backdrop blur, closes on backdrop tap, ✕, Esc, or a
 * downward swipe on the panel/grabber.
 */
export function BottomSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setDragY(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onTouchStart = (e: ReactTouchEvent) => {
    startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    if (startY.current == null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) setDragY(dy);
  };
  const onTouchEnd = () => {
    if (dragY > 80) onClose();
    setDragY(0);
    startY.current = null;
  };

  return (
    <div className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        style={open && dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[88vh] max-w-[560px] overflow-y-auto rounded-t-3xl border-t border-edge bg-bg p-5 pb-8 transition-transform duration-300 ${open ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="-mt-2 mb-3 cursor-grab pt-2"
        >
          <div className="mx-auto h-1 w-10 rounded-full bg-fg3/40" />
        </div>
        <div className="mb-4 flex items-center justify-between">
          <div className="text-base font-bold text-fg">{title}</div>
          <button onClick={onClose} className="px-1 text-lg leading-none text-fg3 hover:text-fg">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Avatar from initials of a full name. */
export function Avatar({ name, tone = 'accent' }: { name: string; tone?: Tone }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <div className={`flex h-9 w-9 flex-none items-center justify-center rounded-xl text-sm font-bold ${TONE[tone]}`}>
      {initials || '?'}
    </div>
  );
}

export const money = (n: number) => new Intl.NumberFormat('ru-RU').format(n || 0);
