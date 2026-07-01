/** Tenant settings: factory name, currency, theme. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Err, Field, Label, PrimaryBtn, Select, Skeleton } from './ui';

const KEYS: { key: string; label: string; placeholder: string; type?: 'select'; options?: { value: string; label: string }[] }[] = [
  { key: 'factory_name', label: 'Название организации', placeholder: 'напр. Zibrock Factory' },
  {
    key: 'currency',
    label: 'Валюта',
    placeholder: 'UZS',
    type: 'select',
    options: [
      { value: 'UZS', label: 'UZS — Сум' },
      { value: 'USD', label: 'USD — Доллар' },
      { value: 'EUR', label: 'EUR — Евро' },
      { value: 'RUB', label: 'RUB — Рубль' },
    ],
  },
  {
    key: 'theme',
    label: 'Тема по умолчанию',
    placeholder: 'dark',
    type: 'select',
    options: [
      { value: 'dark', label: 'Тёмная' },
      { value: 'light', label: 'Светлая' },
    ],
  },
];

export function Settings() {
  const [data, setData] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api.admin
      .settings()
      .then((d: Record<string, string>) => setData(d))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.admin.updateSettings(data);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) return <Err>{error}</Err>;
  if (!data) return <Skeleton />;

  const set = (key: string, value: string) => {
    setSaved(false);
    setData((prev) => ({ ...prev!, [key]: value }));
  };

  return (
    <div className="space-y-5">
      {error && <Err>{error}</Err>}

      <div className="rounded-2xl border border-line bg-card p-4 space-y-4">
        {KEYS.map((k) => (
          <div key={k.key}>
            <Label>{k.label}</Label>
            {k.type === 'select' ? (
              <Select value={data[k.key] ?? ''} onChange={(e) => set(k.key, (e.target as HTMLSelectElement).value)}>
                {!data[k.key] && <option value="">Не задано</option>}
                {k.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Field
                value={data[k.key] ?? ''}
                onChange={(e) => set(k.key, e.target.value)}
                placeholder={k.placeholder}
              />
            )}
          </div>
        ))}
      </div>

      <PrimaryBtn
        className={`w-full transition-colors ${saved ? 'bg-green-600' : ''}`}
        disabled={saving}
        onClick={save}
      >
        {saving ? '...' : saved ? 'Сохранено' : 'Сохранить настройки'}
      </PrimaryBtn>
    </div>
  );
}
