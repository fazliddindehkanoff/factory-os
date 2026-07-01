/** Form builder: add/edit/remove and show-hide the fields of the create-request form. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../telegram';
import { BottomSheet, Err, Field, GhostBtn, Label, MiniBtn, Pill, PrimaryBtn, Select, Skeleton } from './ui';

interface AdminField {
  id: string;
  key: string;
  label: string;
  type: string;
  system: boolean;
  required: boolean;
  enabled: boolean;
  placeholder: string | null;
  options: { value: string; label: string; meta?: string }[];
  step: number;
  orderIndex: number;
}

const TYPE_LABEL: Record<string, string> = {
  text: 'Текст',
  textarea: 'Многострочный',
  number: 'Число',
  select: 'Список выбора',
  date: 'Дата',
  checkbox: 'Флажок',
  file: 'Файл',
};
const TYPE_OPTIONS = Object.entries(TYPE_LABEL);

type Opt = { value: string; label: string; meta?: string };
/** Drop empty rows; new options take value = their label (existing values are kept). */
const finalizeOpts = (opts: Opt[]): Opt[] =>
  opts
    .map((o) => ({ value: (o.value || o.label).trim(), label: o.label.trim(), ...(o.meta ? { meta: o.meta } : {}) }))
    .filter((o) => o.label);

export function FormBuilder() {
  const [fields, setFields] = useState<AdminField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addStep, setAddStep] = useState<number | undefined>(undefined);
  const [stepTarget, setStepTarget] = useState(0);
  const [editing, setEditing] = useState<AdminField | null>(null);

  const load = useCallback(() => {
    api.admin
      .formFields('request_create')
      .then((d) => setFields(Array.isArray(d) ? d : []))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const toggleEnabled = async (f: AdminField) => {
    try {
      await api.admin.updateField(f.id, { enabled: !f.enabled });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (f: AdminField) => {
    if (!(await confirmDialog(`Удалить поле «${f.label}»?`))) return;
    try {
      await api.admin.deleteField(f.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const move = async (f: AdminField, dir: 'up' | 'down') => {
    if (!fields) return;
    const sib = fields.filter((x) => x.step === f.step).sort((a, b) => a.orderIndex - b.orderIndex);
    const i = sib.findIndex((x) => x.id === f.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= sib.length) return;
    const a = sib[i];
    const b = sib[j];
    try {
      await api.admin.reorderFields([
        { id: a.id, orderIndex: b.orderIndex, step: a.step },
        { id: b.id, orderIndex: a.orderIndex, step: b.step },
      ]);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !fields) return <Err>{error}</Err>;
  if (!fields) return <Skeleton />;

  const steps = [...new Set(fields.map((f) => f.step))].sort((a, b) => a - b);
  const maxStep = steps.length ? Math.max(...steps) : 1;
  const shown = Math.max(maxStep, stepTarget, 1);
  const openAdd = (step?: number) => {
    setAddStep(step);
    setAddOpen(true);
  };

  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-fg3">
        Шаги — это экраны мастера при создании заявки. Внутри шага добавляй поля кнопкой «+ Добавить поле».
        Новый шаг — кнопкой «+ Добавить шаг» внизу. Поля можно удалять, выключать и переносить между шагами.
      </p>
      {error && <Err>{error}</Err>}

      {Array.from({ length: shown }, (_, i) => i + 1).map((s) => (
        <div key={s}>
          <Label>Шаг {s}</Label>
          <div className="space-y-2.5">
            {fields
              .filter((f) => f.step === s)
              .map((f, i, arr) => (
                <div
                  key={f.id}
                  className={`rounded-2xl border border-line bg-card p-4 ${f.enabled ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => setEditing(f)} className="min-w-0 flex-1 text-left">
                      <div className="text-sm font-semibold text-fg">{f.label}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <Pill tone="muted">{TYPE_LABEL[f.type] ?? f.type}</Pill>
                        {f.system ? <Pill tone="system">система</Pill> : <Pill tone="accent">своё</Pill>}
                        {f.required && <Pill tone="warning">обязательное</Pill>}
                        {!f.enabled && <Pill tone="danger">выключено</Pill>}
                      </div>
                    </button>
                    <div className="flex flex-none flex-col items-end gap-1.5">
                      <div className="flex gap-1">
                        <MiniBtn className={i === 0 ? 'bg-white/5 text-fg3 opacity-40' : 'bg-white/5 text-fg2'} onClick={() => move(f, 'up')}>
                          ↑
                        </MiniBtn>
                        <MiniBtn className={i === arr.length - 1 ? 'bg-white/5 text-fg3 opacity-40' : 'bg-white/5 text-fg2'} onClick={() => move(f, 'down')}>
                          ↓
                        </MiniBtn>
                      </div>
                      {!(f.system && f.required) && (
                        <MiniBtn onClick={() => toggleEnabled(f)}>{f.enabled ? 'Выкл' : 'Вкл'}</MiniBtn>
                      )}
                      {!f.system && (
                        <MiniBtn className="bg-danger/15 text-danger" onClick={() => remove(f)}>
                          Удалить
                        </MiniBtn>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            <button
              onClick={() => openAdd(s)}
              className="w-full rounded-2xl border border-dashed border-edge py-3 text-sm font-semibold text-accent active:scale-[0.99]"
            >
              + Добавить поле
            </button>
          </div>
        </div>
      ))}

      <GhostBtn className="w-full" onClick={() => setStepTarget(shown + 1)}>
        + Добавить шаг
      </GhostBtn>

      <AddFieldSheet
        open={addOpen}
        initialStep={addStep}
        maxStep={shown}
        onClose={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          load();
        }}
        setError={setError}
      />
      {editing && (
        <EditFieldSheet
          field={editing}
          maxStep={shown}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load();
          }}
          setError={setError}
        />
      )}
    </div>
  );
}

function OptionsEditor({ opts, setOpts }: { opts: Opt[]; setOpts: (f: (a: Opt[]) => Opt[]) => void }) {
  return (
    <div>
      <Label>Варианты выбора (кнопки)</Label>
      <div className="space-y-2">
        {opts.map((o, i) => (
          <div key={i} className="flex gap-2">
            <Field
              value={o.label}
              onChange={(e) => setOpts((a) => a.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))}
              placeholder={`Вариант ${i + 1}`}
            />
            {opts.length > 1 && (
              <MiniBtn className="bg-danger/15 text-danger" onClick={() => setOpts((a) => a.filter((_, idx) => idx !== i))}>
                ✕
              </MiniBtn>
            )}
          </div>
        ))}
      </div>
      <button onClick={() => setOpts((a) => [...a, { value: '', label: '' }])} className="mt-2 text-sm font-semibold text-accent">
        + Вариант
      </button>
    </div>
  );
}

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <label className="mt-3 flex items-center gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
        style={{ accentColor: 'var(--accent)' }}
      />
      <span className="text-sm text-fg">{children}</span>
    </label>
  );
}

function AddFieldSheet({
  open,
  initialStep,
  maxStep,
  onClose,
  onDone,
  setError,
}: {
  open: boolean;
  initialStep?: number;
  maxStep: number;
  onClose: () => void;
  onDone: () => void;
  setError: (s: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [step, setStep] = useState(1);
  const [required, setRequired] = useState(false);
  const [opts, setOpts] = useState<Opt[]>([{ value: '', label: '' }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setStep(initialStep ?? 1);
  }, [open, initialStep]);

  const reset = () => {
    setLabel('');
    setType('text');
    setStep(1);
    setRequired(false);
    setOpts([{ value: '', label: '' }]);
  };

  const submit = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      let options: Opt[] | undefined;
      if (type === 'select') {
        options = finalizeOpts(opts);
        if (options.length === 0) {
          setError('Добавьте хотя бы один вариант');
          setSaving(false);
          return;
        }
      }
      await api.admin.createField({ label: label.trim(), type, step, required, options });
      reset();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open={open} title="Новое поле" onClose={onClose}>
      <Label>Название поля</Label>
      <Field value={label} onChange={(e) => setLabel(e.target.value)} placeholder="напр. Артикул поставщика" autoFocus />
      <div className="mt-4">
        <Label>Тип поля</Label>
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPE_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </div>
      <div className="mt-4">
        <Label>На каком шаге</Label>
        <Select value={String(step)} onChange={(e) => setStep(Number(e.target.value))}>
          {Array.from({ length: maxStep }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              Шаг {n}
            </option>
          ))}
          <option value={maxStep + 1}>➕ Новый шаг {maxStep + 1}</option>
        </Select>
      </div>
      {type === 'select' && (
        <div className="mt-4">
          <OptionsEditor opts={opts} setOpts={setOpts} />
        </div>
      )}
      <CheckRow checked={required} onChange={setRequired}>
        Обязательное поле
      </CheckRow>
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>
          Отмена
        </GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !label.trim()} onClick={submit}>
          {saving ? '…' : 'Добавить'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}

function EditFieldSheet({
  field,
  maxStep,
  onClose,
  onDone,
  setError,
}: {
  field: AdminField;
  maxStep: number;
  onClose: () => void;
  onDone: () => void;
  setError: (s: string) => void;
}) {
  const editableOptions = field.type === 'select' && field.key !== 'warehouse';
  const [label, setLabel] = useState(field.label);
  const [step, setStep] = useState(field.step);
  const [required, setRequired] = useState(field.required);
  const [enabled, setEnabled] = useState(field.enabled);
  const [opts, setOpts] = useState<Opt[]>(
    editableOptions && Array.isArray(field.options) && field.options.length
      ? field.options.map((o) => ({ value: o.value, label: o.label, ...(o.meta ? { meta: o.meta } : {}) }))
      : editableOptions
        ? [{ value: '', label: '' }]
        : [],
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { label: label.trim(), step, required, enabled };
      if (editableOptions) {
        const options = finalizeOpts(opts);
        if (options.length === 0) {
          setError('Добавьте хотя бы один вариант');
          setSaving(false);
          return;
        }
        patch.options = options;
      }
      await api.admin.updateField(field.id, patch);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet open title={`Поле: ${field.label}`} onClose={onClose}>
      <Label>Название</Label>
      <Field value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
      <div className="mt-4">
        <Label>Шаг</Label>
        <Select value={String(step)} onChange={(e) => setStep(Number(e.target.value))}>
          {Array.from({ length: maxStep }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              Шаг {n}
            </option>
          ))}
          <option value={maxStep + 1}>➕ Новый шаг {maxStep + 1}</option>
        </Select>
      </div>
      {editableOptions && (
        <div className="mt-4">
          <OptionsEditor opts={opts} setOpts={setOpts} />
        </div>
      )}
      <CheckRow checked={required} onChange={setRequired}>
        Обязательное
      </CheckRow>
      <CheckRow checked={enabled} onChange={setEnabled}>
        Показывать в форме
      </CheckRow>
      {field.system && (
        <p className="mt-3 text-xs leading-relaxed text-fg3">
          Системное поле: нельзя поменять только тип. Название, варианты-кнопки, обязательность, видимость и шаг —
          можно.
        </p>
      )}
      <div className="mt-5 flex gap-2.5">
        <GhostBtn className="flex-1" onClick={onClose}>
          Отмена
        </GhostBtn>
        <PrimaryBtn className="flex-1" disabled={saving || !label.trim()} onClick={submit}>
          {saving ? '…' : 'Сохранить'}
        </PrimaryBtn>
      </div>
    </BottomSheet>
  );
}
