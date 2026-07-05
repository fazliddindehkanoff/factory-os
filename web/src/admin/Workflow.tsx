/** Approval workflow: pick a chain, reorder/add/edit steps, activate. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Empty, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton, money } from './ui';

interface Step {
  id: string;
  stepOrder: number;
  stepName: string;
  stepKind: string;
  approverRoleId: string | null;
  thresholdAmount: number | null;
  conditionRule: { amountGte?: number; amountLt?: number; inStock?: boolean; requestType?: string } | null;
  onReject: string | null;
  onRejectStepOrder: number | null;
}

const REQUEST_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'material_request', label: 'Материал' },
  { value: 'service_request', label: 'Услуга' },
  { value: 'repair_request', label: 'Ремонт' },
];
const requestTypeLabel = (v: string) => REQUEST_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v;

// What each step DOES — drives the request through the lifecycle (data-driven).
const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'approval', label: 'Согласование (подпись, PIN)' },
  { value: 'warehouse_check', label: 'Проверка склада (в наличии / нет)' },
  { value: 'procurement', label: 'Закупка (КП + поставщик)' },
  { value: 'finance_payment', label: 'Оплата (PIN)' },
  { value: 'delivery', label: 'Доставка' },
  { value: 'receiving', label: 'Приёмка на склад' },
  { value: 'issue', label: 'Выдача в отдел' },
  { value: 'close', label: 'Подтверждение получения (закрытие)' },
];
const kindLabel = (k: string) => KIND_OPTIONS.find((o) => o.value === k)?.label ?? k;
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
  kind: string;
  roleId: string;
  threshold: string;
  /** Порядковый номер этого шага (для списка «вернуть на шаг…» — только более ранние). */
  ownOrder: number;
  // Условия включения шага (condition_rule)
  amountLt: string;
  requestType: string;
  stockCond: '' | 'in' | 'out';
  // Ветка «Если отклонил»
  onReject: string;
  onRejectStep: string;
}

const emptyConditions = { amountLt: '', requestType: '', stockCond: '' as const, onReject: 'cancel', onRejectStep: '' };

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
      const rule: Record<string, unknown> = {};
      if (stepSheet.amountLt.trim() !== '') rule.amountLt = Number(stepSheet.amountLt);
      if (stepSheet.requestType) rule.requestType = stepSheet.requestType;
      if (stepSheet.stockCond === 'in') rule.inStock = true;
      if (stepSheet.stockCond === 'out') rule.inStock = false;
      const common = {
        name: stepSheet.name.trim(),
        step_kind: stepSheet.kind,
        approver_role_id: roleId,
        threshold_amount: threshold,
        condition_rule: Object.keys(rule).length ? rule : null,
        on_reject: stepSheet.onReject,
        on_reject_step_order: stepSheet.onReject === 'return_step' ? Number(stepSheet.onRejectStep) : null,
      };
      if (stepSheet.mode === 'add') {
        await api.admin.addStep(selectedId, { ...common, order_index: localSteps.length + 1 });
      } else {
        await api.admin.updateStep(selectedId, stepSheet.id!, common);
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
        <MiniBtn
          className="bg-accent/15 text-accent"
          disabled={dirty}
          onClick={() => setStepSheet({ mode: 'add', name: '', kind: 'approval', roleId: '', threshold: '', ownOrder: localSteps.length + 1, ...emptyConditions })}
        >
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
              onClick={() =>
                setStepSheet({
                  mode: 'edit',
                  id: s.id,
                  name: s.stepName,
                  kind: s.stepKind ?? 'approval',
                  roleId: s.approverRoleId ?? '',
                  threshold: s.thresholdAmount != null ? String(s.thresholdAmount) : '',
                  ownOrder: s.stepOrder,
                  amountLt: s.conditionRule?.amountLt != null ? String(s.conditionRule.amountLt) : '',
                  requestType: s.conditionRule?.requestType ?? '',
                  stockCond: s.conditionRule?.inStock === true ? 'in' : s.conditionRule?.inStock === false ? 'out' : '',
                  onReject: s.onReject ?? 'cancel',
                  onRejectStep: s.onRejectStepOrder != null ? String(s.onRejectStepOrder) : '',
                })
              }
              className="min-w-0 flex-1 p-3 text-left disabled:opacity-60"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-fg3">{i + 1}.</span>
                <span className="truncate text-sm font-semibold text-fg">{s.stepName}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Pill tone="accent">{kindLabel(s.stepKind ?? 'approval')}</Pill>
                {(s.stepKind ?? 'approval') === 'approval' && (
                  <Pill tone="system">{s.approverRoleId ? roleName.get(s.approverRoleId) ?? 'роль' : 'без роли'}</Pill>
                )}
                {s.thresholdAmount != null && <Pill tone="warning">от {money(s.thresholdAmount)} UZS</Pill>}
                {s.conditionRule?.amountLt != null && <Pill tone="warning">до {money(s.conditionRule.amountLt)} UZS</Pill>}
                {s.conditionRule?.requestType && <Pill tone="warning">тип: {requestTypeLabel(s.conditionRule.requestType)}</Pill>}
                {s.conditionRule?.inStock === true && <Pill tone="warning">если в наличии</Pill>}
                {s.conditionRule?.inStock === false && <Pill tone="warning">если нет в наличии</Pill>}
                {s.onReject === 'return_requester' && <Pill tone="danger">✕ → на доработку</Pill>}
                {s.onReject === 'return_step' && <Pill tone="danger">✕ → на шаг {s.onRejectStepOrder}</Pill>}
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
              <Label>Тип шага</Label>
              <Select value={stepSheet.kind} onChange={(e) => setStepSheet({ ...stepSheet, kind: (e.target as HTMLSelectElement).value })}>
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div className="mt-1 text-xs text-fg3">Определяет, что происходит на шаге и какие действия доступны.</div>
            </div>
            <div className="mt-4">
              <Label>Кто согласует{stepSheet.kind === 'approval' ? '' : ' (для подписи)'}</Label>
              <Select value={stepSheet.roleId} onChange={(e) => setStepSheet({ ...stepSheet, roleId: (e.target as HTMLSelectElement).value })}>
                <option value="">Не выбрано</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg3">Условия включения шага</div>
              <div className="mt-1 text-xs text-fg3">Шаг попадает в маршрут, только если ВСЕ заданные условия выполнены. Пустое поле — условие не проверяется.</div>
              <div className="mt-3 flex gap-2.5">
                <div className="flex-1">
                  <Label>Сумма от, UZS</Label>
                  <Field
                    value={stepSheet.threshold}
                    onChange={(e) => setStepSheet({ ...stepSheet, threshold: e.target.value })}
                    placeholder="напр. 5000000"
                    inputMode="numeric"
                  />
                </div>
                <div className="flex-1">
                  <Label>Сумма до, UZS</Label>
                  <Field
                    value={stepSheet.amountLt}
                    onChange={(e) => setStepSheet({ ...stepSheet, amountLt: e.target.value })}
                    placeholder="без границы"
                    inputMode="numeric"
                  />
                </div>
              </div>
              <div className="mt-3">
                <Label>Тип заявки</Label>
                <Select value={stepSheet.requestType} onChange={(e) => setStepSheet({ ...stepSheet, requestType: (e.target as HTMLSelectElement).value })}>
                  <option value="">Любой</option>
                  {REQUEST_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="mt-3">
                <Label>Наличие на складе</Label>
                <Select value={stepSheet.stockCond} onChange={(e) => setStepSheet({ ...stepSheet, stockCond: (e.target as HTMLSelectElement).value as StepSheet['stockCond'] })}>
                  <option value="">Не важно</option>
                  <option value="out">Только если НЕТ в наличии</option>
                  <option value="in">Только если ЕСТЬ в наличии</option>
                </Select>
                <div className="mt-1 text-xs text-fg3">Работает после шага «Проверка склада» — например, закупка нужна только когда товара нет.</div>
              </div>
            </div>
            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-fg3">Если отклонил</div>
              <Select value={stepSheet.onReject} onChange={(e) => setStepSheet({ ...stepSheet, onReject: (e.target as HTMLSelectElement).value })}>
                <option value="cancel">Отменить заявку (отклонена окончательно)</option>
                <option value="return_requester">Вернуть заявителю на доработку</option>
                <option value="return_step" disabled={stepSheet.ownOrder <= 1}>
                  Вернуть на более ранний шаг…
                </option>
              </Select>
              {stepSheet.onReject === 'return_step' && (
                <div className="mt-3">
                  <Label>На какой шаг вернуть</Label>
                  <Select value={stepSheet.onRejectStep} onChange={(e) => setStepSheet({ ...stepSheet, onRejectStep: (e.target as HTMLSelectElement).value })}>
                    <option value="">Выберите шаг</option>
                    {localSteps
                      .filter((s) => s.stepOrder < stepSheet.ownOrder)
                      .map((s) => (
                        <option key={s.id} value={String(s.stepOrder)}>
                          {s.stepOrder}. {s.stepName}
                        </option>
                      ))}
                  </Select>
                </div>
              )}
              {stepSheet.onReject === 'return_requester' && (
                <div className="mt-1 text-xs text-fg3">Заявка получит статус «На доработке»: автор сможет исправить её и отправить повторно — маршрут начнётся заново.</div>
              )}
            </div>
            <div className="mt-5 flex gap-2.5">
              {stepSheet.mode === 'edit' && (
                <GhostBtn className="bg-danger/15 text-danger" onClick={deleteStep}>
                  Удалить
                </GhostBtn>
              )}
              <PrimaryBtn
                className="flex-1"
                disabled={busy || !stepSheet.name.trim() || (stepSheet.onReject === 'return_step' && !stepSheet.onRejectStep)}
                onClick={submitStep}
              >
                {busy ? '…' : 'Сохранить'}
              </PrimaryBtn>
            </div>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
