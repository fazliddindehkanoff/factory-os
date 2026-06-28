/** Admin section shell: tab routing between the five constructor pages. */
import { useState } from 'react';
import { Dashboard } from './Dashboard';
import { Structure } from './Structure';
import { People } from './People';
import { Roles } from './Roles';
import { WorkflowPage } from './Workflow';
import { FormBuilder } from './FormBuilder';

type Tab = 'dashboard' | 'structure' | 'people' | 'roles' | 'workflow' | 'form';

const TABS: { key: Tab; label: string; perm: string | null }[] = [
  { key: 'dashboard', label: 'Обзор', perm: null },
  { key: 'structure', label: 'Структура', perm: 'settings.manage' },
  { key: 'people', label: 'Люди', perm: 'users.manage' },
  { key: 'roles', label: 'Роли', perm: 'roles.manage' },
  { key: 'workflow', label: 'Workflow', perm: 'workflows.manage' },
  { key: 'form', label: 'Форма заявки', perm: 'settings.manage' },
];

export function AdminPanel({ permissions, onExit }: { permissions: string[]; onExit: () => void }) {
  const can = (p: string | null) => p === null || permissions.includes(p);
  const visible = TABS.filter((t) => can(t.perm));
  const [tab, setTab] = useState<Tab>(visible[0]?.key ?? 'dashboard');

  return (
    <div>
      <button onClick={onExit} className="mb-3 text-sm font-medium text-fg2 hover:text-fg">
        ← В приложение
      </button>

      <div className="-mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1">
        {visible.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-none rounded-xl px-3.5 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-accent text-white shadow-lg shadow-accent/20' : 'bg-card text-fg2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <Dashboard />}
      {tab === 'structure' && <Structure />}
      {tab === 'people' && <People />}
      {tab === 'roles' && <Roles />}
      {tab === 'workflow' && <WorkflowPage />}
      {tab === 'form' && <FormBuilder />}
    </div>
  );
}
