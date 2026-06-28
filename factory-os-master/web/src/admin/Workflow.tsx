/** Approval workflow: pick a chain, reorder/add/edit steps, activate. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton, money } from './ui';

interface Step {
  id: string;
  stepOrder: number;
  stepName: string;
  approverRoleId: string | null;
  thresholdAmount: number | null;
}
interface Workflow {
  id: string;
  name: string;
  module: string;
  isActive: boolean;
  steps: Step[];
}
interface RoleOpt {
  id: string;
  code: string;
  name: string;
}

interface StepSheet {
  mode: 'add' | 'edit';
  id?: string;
  name: string;
  roleId: string;
  threshold: string;
}

export function WorkflowPage() {
  const [wfs, setWfs] = useState<Workflow[] | null>(null);
  const [roles, setRoles] = useState<RoleOpt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [localSteps, setLocalSteps] = useState<Step[]>([]);
  const [dirty, setDirty] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [stepSheet, setStepSheet] = useState<StepSheet | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (keepId?: string) =>
      api.admin
        .workflows()
        .then((w: Workflow[]) => {
          setWfs(w);
          const pick = keepId && w.some((x) => x.id === keepId) ? keepId : w.find((x) => x.isActive)?.id ?? w[0]?.id ?? '';
          setSelectedId(pick);
          setLocalSteps([...(w.find((x) => x.id === pick)?.steps ?? [])]);
          setDirty(false);
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  // Roles only feed the approver dropdown; a workflows.manage-only admin (no
  // roles.manage) still edits the chain — load them best-effort.
  const loadRoles = useCallback(() => {
    api.admin.roles().then(setRoles).catch(() => setRoles([]));
  }, []);
  useEffect(() => {
    load();
    loadRoles();
  }, [load, loadRoles]);

  const wf = useMemo(() => wfs?.find((x) => x.id === selectedId) ?? null, [wfs, selectedId]);
  const roleName = useMemo(() => new Map(roles.map((r) => [r.id, r.name])), [roles]);

  const selectWf = (id: string) => {
    setSelectedId(id);
    setLocalSteps([...(wfs?.find((x) => x.id === id)?.steps ?? [])]);
    setDirty(false);
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= localSteps.length) return;
    const next = [...localSteps];
    [next[i], next[j]] = [next[j], next[i]];
    setLocalSteps(next);
    setDirty(true);
  };

  const saveOrder = async () => {
    setBusy(true);
    try {
      await api.admin.reorderSteps(selectedId, localSteps.map((s, i) => ({ id: s.id, order_index: i + 1 })));
      await load(selectedId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    setBusy(true);
    try {
      await api.admin.updateWorkflow(selectedId, { is_active: true });
      await load(selectedId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createChain = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const created = await api.admin.createWorkflow(newName.trim());
      setNewName('');
      setNewOpen(false);
      await load(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitStep = async () => {
    if (!stepSheet || !stepSheet.name.trim()) return;
    setBusy(true);
    try {
      const threshold = stepSheet.threshold.trim() === '' ? null : Number(stepSheet.threshold);
      const roleId = stepSheet.roleId || null;
      if (stepSheet.mode === 'add') {
        await api.admin.addStep(selectedId, {
          name: stepSheet.name.trim(),
          approver_role_id: roleId,
          order_index: localSteps.length + 1,
          threshold_amount: threshold,
        });
      } else {
        await api.admin.updateStep(selectedId, stepSheet.id!, {
          name: stepSheet.name.trim(),
          approver_role_id: roleId,
          threshold_amount: threshold,
        });
      }
      setStepSheet(null);
      await load(selectedId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteStep = async () => {
    if (!stepSheet?.id || !(await confirmDialog('Удалить шаг?'))) return;
    setBusy(true);
    try {
      await api.admin.deleteStep(selectedId, stepSheet.id);
      setStepSheet(null);
      await load(selectedId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !wfs) return <Err>{error}</Err>;
  if (!wfs) return <Skeleton />;

  return (
    <div className="space-y-4">
      {error && <Err>{error}</Err>}

      <div className="flex items-center gap-2.5">
        <Select className="flex-1" value={selectedId} onChange={(e) => selectWf((e.target as HTMLSelectElement).value)}>
          {wfs.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.isActive ? ' • активна' : ''}
            </option>
          ))}
        </Select>
        <PrimaryBtn onClick={() => setNewOpen(true)}>+ Цепочка</PrimaryBtn>
      </div>

      {wf && (
        <div className="flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3">
          <div className="text-sm font-semibold text-fg">{wf.name}</div>
          {wf.isActive ? (
            <Pill tone="success">Активна</Pill>
          ) : (
            <MiniBtn className="bg-accent/15 text-accent" onClick={activate}>
              Сделать активной
            </MiniBtn>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <Label>Шаги согласования</Label>
        <MiniBtn className="bg-accent/15 text-accent" disabled={dirty} onClick={() => setStepSheet({ mode: 'add', name: '', roleId: '', threshold: '' })}>
          + Добавить шаг
        </MiniBtn>
      </div>

      {dirty && (
        <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          Сначала сохраните порядок — затем можно добавлять и менять шаги.
        </div>
      )}

      {localSteps.length === 0 && <Empty>В этой цепочке нет шагов.</Empty>}
      <div className="space-y-2.5">
        {localSteps.map((s, i) => (
          <div key={s.id} className="flex items-stretch overflow-hidden rounded-2xl border border-line bg-card">
            <div className="w-1.5 flex-none bg-accent" />
            <button
              disabled={dirty}
              onClick={() => setStepSheet({ mode: 'edit', id: s.id, name: s.stepName, roleId: s.approverRoleId ?? '', threshold: s.thresholdAmount != null ? String(s.thresholdAmount) : '' })}
              className="min-w-0 flex-1 p-3 text-left disabled:opacity-60"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-fg3">{i + 1}.</span>
                <span className="truncate text-sm font-semibold text-fg">{s.stepName}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Pill tone="system">{s.approverRoleId ? roleName.get(s.approverRoleId) ?? 'роль' : 'без роли'}</Pill>
                {s.thresholdAmount != null && <Pill tone="warning">от {money(s.thresholdAmount)} UZS</Pill>}
              </div>
            </button>
            <div className="flex flex-none flex-col justify-center gap-1 px-2">
              <MiniBtn disabled={i === 0} onClick={() => move(i, -1)}>
                ▲
              </MiniBtn>
              <MiniBtn disabled={i === localSteps.length - 1} onClick={() => move(i, 1)}>
                ▼
              </MiniBtn>
            </div>
          </div>
        ))}
      </div>

      {dirty && (
        <PrimaryBtn className="w-full" disabled={busy} onClick={saveOrder}>
          {busy ? '…' : 'Сохранить порядок'}
        </PrimaryBtn>
      )}

      {/* New chain */}
      <BottomSheet open={newOpen} title="Новая цепочка" onClose={() => setNewOpen(false)}>
        <Label>Название</Label>
        <Field autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="напр. Закупка оборудования" />
        <div className="mt-5 flex gap-2.5">
          <GhostBtn className="flex-1" onClick={() => setNewOpen(false)}>
            Отмена
          </GhostBtn>
          <PrimaryBtn className="flex-1" disabled={busy || !newName.trim()} onClick={createChain}>
            Создать
          </PrimaryBtn>
        </div>
      </BottomSheet>

      {/* Add / edit step */}
      <BottomSheet open={!!stepSheet} title={stepSheet?.mode === 'add' ? 'Новый шаг' : 'Изменить шаг'} onClose={() => setStepSheet(null)}>
        {stepSheet && (
          <div>
            <Label>Название шага</Label>
            <Field autoFocus value={stepSheet.name} onChange={(e) => setStepSheet({ ...stepSheet, name: e.target.value })} placeholder="напр. Финансы" />
            <div className="mt-4">
              <Label>Согласующая роль</Label>
              <Select value={stepSheet.roleId} onChange={(e) => setStepSheet({ ...stepSheet, roleId: (e.target as HTMLSelectElement).value })}>
                <option value="">Без роли</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-4">
              <Label>Порог суммы, UZS (необязательно)</Label>
              <Field
                value={stepSheet.threshold}
                onChange={(e) => setStepSheet({ ...stepSheet, threshold: e.target.value })}
                placeholder="напр. 5000000"
                inputMode="numeric"
              />
              <div className="mt-1 text-xs text-fg3">Шаг включается, если сумма заявки ≥ порога.</div>
            </div>
            <div className="mt-5 flex gap-2.5">
              {stepSheet.mode === 'edit' && (
                <GhostBtn className="bg-danger/15 text-danger" onClick={deleteStep}>
                  Удалить
                </GhostBtn>
              )}
              <PrimaryBtn className="flex-1" disabled={busy || !stepSheet.name.trim()} onClick={submitStep}>
                {busy ? '…' : 'Сохранить'}
              </PrimaryBtn>
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
