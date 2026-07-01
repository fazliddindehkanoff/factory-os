/** Admin home: holding-wide counts. */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Err, Skeleton } from './ui';

interface Overview {
  factories: number;
  departments: number;
  warehouses: number;
  users: number;
  roles: number;
  activeRequests: number;
}

const CARDS: { key: keyof Overview; label: string; tint: string }[] = [
  { key: 'departments', label: 'Отделы', tint: 'bg-accent/15 text-accent' },
  { key: 'warehouses', label: 'Склады', tint: 'bg-success/15 text-success' },
  { key: 'users', label: 'Пользователи', tint: 'bg-warning/15 text-warning' },
  { key: 'roles', label: 'Роли', tint: 'bg-accent/15 text-accent' },
  { key: 'factories', label: 'Заводы', tint: 'bg-fg3/20 text-fg2' },
  { key: 'activeRequests', label: 'Активные заявки', tint: 'bg-danger/15 text-danger' },
];

export function Dashboard() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.admin
      .overview()
      .then(setOv)
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <Err>{error}</Err>;
  if (!ov) return <Skeleton />;

  return (
    <div className="grid grid-cols-2 gap-3">
      {CARDS.map((c) => (
        <div key={c.key} className="rounded-2xl border border-line bg-card p-4">
          <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl ${c.tint}`}>●</div>
          <div className="font-mono text-3xl font-semibold text-fg">{ov[c.key]}</div>
          <div className="mt-1 text-xs text-fg2">{c.label}</div>
        </div>
      ))}
    </div>
  );
}
