/** Admin section shell: tab routing between the constructor pages. */
import { useState } from 'react';
import { Dashboard } from './Dashboard';
import { Structure } from './Structure';
import { People } from './People';
import { Roles } from './Roles';
import { WorkflowPage } from './Workflow';
import { FormBuilder } from './FormBuilder';
import { Settings } from './Settings';
import { Materials } from './Materials';
import { AuditLog } from './AuditLog';

type Tab = 'dashboard' | 'structure' | 'people' | 'roles' | 'workflow' | 'form' | 'materials' | 'audit' | 'settings';

const TABS: { key: Tab; label: string; perm: string | null }[] = [
  { key: 'dashboard', label: 'Обзор', perm: null },
  { key: 'structure', label: 'Структура', perm: 'settings.manage' },
  { key: 'people', label: 'Люди', perm: 'users.manage' },
  { key: 'roles', label: 'Права', perm: 'roles.manage' },
  { key: 'workflow', label: 'Workflow', perm: 'workflows.manage' },
  { key: 'form', label: 'Форма', perm: 'settings.manage' },
  { key: 'materials', label: 'Материалы', perm: 'warehouse.view' },
  { key: 'audit', label: 'Аудит', perm: 'audit.view' },
  { key: 'settings', label: 'Настройки', perm: 'settings.manage' },
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
      {tab === 'materials' && <Materials />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
