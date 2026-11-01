// Общая карточка CRM (S0-15): форма создания/правки, архив вместо удаления, история изменений из аудита (K2).
// Правила владельца: удаление – только внутри записи, через окно с выбором «в архив»; системное значение окно
// объясняет и ничего не делает. Форма помечена data-guard – несохранённый ввод не теряется молча (ContextSwitcher).
// Правка – только изменённые поля + rowVersion (K11: устарело → 409 VERSION_CONFLICT).
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall, ROLE_LABEL, type StaffRole } from '../lib/api.ts';
import { fill } from './EntityList.tsx';

export interface CardField {
  kind: 'text' | 'number' | 'select' | 'checkbox' | 'weekly';
  name: string;
  label: string;
  required?: boolean;
  readOnly?: boolean;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  /** Подписи значений для истории, которых нет среди options (например, «В архиве»). */
  labels?: Record<string, string>;
  min?: number;
  max?: number;
}

export interface CardProps {
  fields: CardField[];
  values: Record<string, unknown>;
  /** Нет – карточка только для просмотра. redirect – куда после создания, поля ответа подставляются. */
  save?: { method: 'POST' | 'PATCH'; path: string; label: string; versioned?: boolean; redirect?: string };
  rowVersion?: number;
  /** blocked – удалить и архивировать нельзя (системное значение), текст – почему. */
  remove?: { archived: boolean; archivePath?: string; restorePath?: string; blocked?: string; versioned?: boolean; what: string };
  /** omit – ключи, которых нет в истории (ПДн без права client.view.full). */
  history?: { objectType: string; objectId: string; timezone?: string; omit?: string[] };
  /** Только история: fields – подписи полей в ней, форма не рисуется (данные показывает страница). */
  historyOnly?: boolean;
}

type Hours = { weekday: number; open: string | null; close: string | null };
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const errorText = (e: unknown) => (e instanceof ApiError ? e.message.replace(/\.$/, '') : 'Неизвестная ошибка');

function hoursOf(v: unknown): Hours[] {
  const list = Array.isArray(v) ? (v as Hours[]) : [];
  return DAYS.map((_, i) => list.find((d) => d.weekday === i + 1) ?? { weekday: i + 1, open: null, close: null });
}

function hoursText(v: unknown): string {
  return hoursOf(v)
    .map((d) => `${DAYS[d.weekday - 1]} ${d.open && d.close ? `${d.open}–${d.close}` : 'выходной'}`)
    .join(', ');
}

/** Значение поля для показа в истории. */
function show(f: CardField | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (f?.kind === 'weekly') return hoursText(v);
  if (typeof v === 'boolean') return v ? 'Да' : 'Нет';
  const opt = f?.options?.find((o) => o.value === String(v));
  if (opt) return opt.label;
  if (f?.labels?.[String(v)]) return f.labels[String(v)]!;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Считать значения формы по описанию полей. Ошибки заполнения – по имени поля. */
function read(form: HTMLFormElement, fields: CardField[]): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const el = (name: string) => form.elements.namedItem(name) as HTMLInputElement | null;
  for (const f of fields) {
    if (f.readOnly) continue;
    if (f.kind === 'checkbox') {
      data[f.name] = Boolean(el(f.name)?.checked);
    } else if (f.kind === 'weekly') {
      const days: Hours[] = [];
      const bad: string[] = [];
      for (let d = 1; d <= 7; d++) {
        if (!el(`${f.name}-${d}-on`)?.checked) {
          days.push({ weekday: d, open: null, close: null });
          continue;
        }
        const open = el(`${f.name}-${d}-open`)?.value ?? '';
        const close = el(`${f.name}-${d}-close`)?.value ?? '';
        if (!TIME.test(open) || !TIME.test(close) || close <= open) bad.push(DAYS[d - 1]!);
        days.push({ weekday: d, open, close });
      }
      if (bad.length) errors[f.name] = `${bad.join(', ')}: закрытие позже открытия, в пределах суток`;
      data[f.name] = days;
    } else {
      const raw = (el(f.name)?.value ?? '').trim();
      if (!raw) {
        if (f.required) errors[f.name] = 'Заполните поле';
        data[f.name] = null;
      } else {
        data[f.name] = f.kind === 'number' ? Number(raw) : raw;
      }
    }
  }
  return { data, errors };
}

/** Текущие значения формы – новая точка «без изменений» (после сохранения). */
function markClean(form: HTMLFormElement | null) {
  if (!form) return;
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      el.defaultValue = el.value;
      el.defaultChecked = el.checked;
    } else if (el instanceof HTMLSelectElement) {
      for (const o of Array.from(el.options)) o.defaultSelected = o.selected;
    }
  }
}

function Weekly({ f, value, error }: { f: CardField; value: unknown; error?: string }) {
  return (
    <fieldset class="yc-week" aria-describedby={error ? `${f.name}-error` : undefined}>
      <legend class="yc-field__label">{f.label}</legend>
      {f.hint && <span class="yc-field__hint">{f.hint}</span>}
      {hoursOf(value).map((d) => (
        <div class="yc-week__day" key={d.weekday}>
          <label class="yc-check">
            <input type="checkbox" name={`${f.name}-${d.weekday}-on`} defaultChecked={Boolean(d.open)} disabled={f.readOnly} />
            <span>{DAYS[d.weekday - 1]}</span>
          </label>
          <input class="yc-input" type="time" name={`${f.name}-${d.weekday}-open`} aria-label={`${DAYS[d.weekday - 1]}, открытие`}
            defaultValue={d.open ?? '10:00'} disabled={f.readOnly} />
          <span aria-hidden="true">–</span>
          <input class="yc-input" type="time" name={`${f.name}-${d.weekday}-close`} aria-label={`${DAYS[d.weekday - 1]}, закрытие`}
            defaultValue={d.close ?? '22:00'} disabled={f.readOnly} />
        </div>
      ))}
      {error && <span class="yc-field__error" id={`${f.name}-error`}>{error}</span>}
    </fieldset>
  );
}

function Field({ f, value, error }: { f: CardField; value: unknown; error?: string }) {
  if (f.kind === 'weekly') return <Weekly f={f} value={value} error={error} />;
  const id = `f-${f.name}`;
  const described = [f.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  if (f.kind === 'checkbox') {
    return (
      <div class="yc-field">
        <label class="yc-check">
          <input type="checkbox" id={id} name={f.name} defaultChecked={Boolean(value)} disabled={f.readOnly} aria-describedby={described} />
          <span>{f.label}</span>
        </label>
        {f.hint && <span class="yc-field__hint" id={`${id}-hint`}>{f.hint}</span>}
      </div>
    );
  }
  const text = value === null || value === undefined ? '' : String(value);
  const common = { id, name: f.name, class: 'yc-input', 'aria-invalid': error ? (true as const) : undefined, 'aria-describedby': described };
  return (
    <div class="yc-field">
      <label class="yc-field__label" for={id}>
        {f.label}
        {f.required && !f.readOnly ? ' *' : ''}
      </label>
      {f.kind === 'select' ? (
        <select {...common} disabled={f.readOnly}>
          {!f.required && <option value="">–</option>}
          {f.options?.map((o) => (
            <option key={o.value} value={o.value} selected={o.value === String(value ?? '')}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        f.kind === 'number' ? (
          <input {...common} type="number" min={f.min} max={f.max} defaultValue={text} readOnly={f.readOnly} />
        ) : (
          <input {...common} type="text" defaultValue={text} readOnly={f.readOnly} />
        )
      )}
      {f.hint && <span class="yc-field__hint" id={`${id}-hint`}>{f.hint}</span>}
      {error && <span class="yc-field__error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

interface AuditView {
  id: string;
  at: string;
  action: string;
  actor: { id: string; name: string; role: StaffRole | null } | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  created: 'Создание', updated: 'Изменение', archived: 'В архив', status_changed: 'Смена статуса', hours_changed: 'Изменение графика',
  changed: 'Изменение',
};
const REASON_LABEL: Record<string, string> = { create: 'Создание', update: 'Изменение', archive: 'В архив', restore: 'Из архива' };

function History({ h, fields, reloadKey }: { h: NonNullable<CardProps['history']>; fields: CardField[]; reloadKey: number }) {
  const [items, setItems] = useState<AuditView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const fmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', ...(h.timezone ? { timeZone: h.timezone } : {}) });

  const load = async (more: boolean) => {
    setState('loading');
    try {
      const sp = new URLSearchParams({ objectType: h.objectType, objectId: h.objectId, limit: '20' });
      if (more && cursor) sp.set('cursor', cursor);
      const r = await browserCall<{ items: AuditView[]; nextCursor: string | null }>(`/audit/timeline?${sp}`);
      setItems((prev) => (more ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
      setState('ready');
    } catch (e) {
      setError(errorText(e));
      setState('error');
    }
  };

  useEffect(() => {
    void load(false);
  }, [reloadKey]);

  const title = (e: AuditView) =>
    (e.reason && REASON_LABEL[e.reason]) || ACTION_LABEL[e.action.split('.').slice(1).join('.')] || e.action;

  return (
    <section class="yc-panel" aria-labelledby="history-title" data-testid="history">
      <h2 id="history-title">История изменений</h2>
      {items.length === 0 && state === 'ready' && <p class="yc-empty">Изменений пока нет.</p>}
      {items.length > 0 && (
        <ol class="yc-history">
          {items.map((e) => {
            const keys = Object.keys({ ...(e.before ?? {}), ...(e.after ?? {}) }).filter((k) => !h.omit?.includes(k));
            return (
              <li class="yc-history__item" key={e.id}>
                <p class="yc-history__head">
                  <strong>{title(e)}</strong> · {fmt.format(new Date(e.at))} ·{' '}
                  {e.actor ? `${e.actor.name}${e.actor.role ? ` (${ROLE_LABEL[e.actor.role]})` : ''}` : 'Система'}
                </p>
                {keys.length > 0 && (
                  <ul class="yc-history__changes">
                    {keys.map((k) => {
                      const f = fields.find((x) => x.name === k);
                      const was = e.before?.[k];
                      const now = e.after?.[k];
                      return (
                        <li key={k}>
                          {f?.label ?? k}: {was === undefined || was === null ? '' : `${show(f, was)} → `}
                          {show(f, now)}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {state === 'loading' && <p class="yc-empty" role="status">Загрузка истории…</p>}
      {state === 'error' && (
        <div class="yc-alert yc-alert--error yc-list__error" role="alert">
          <span>История не загрузилась: {error}.</span>
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void load(items.length > 0)}>
            Повторить
          </button>
        </div>
      )}
      {state === 'ready' && cursor && (
        <div>
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void load(true)}>
            Показать ещё
          </button>
        </div>
      )}
    </section>
  );
}

export default function EntityCard(props: CardProps) {
  const { fields, save, remove, history } = props;
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = useRef<Record<string, unknown>>(props.values);
  const [rowVersion, setRowVersion] = useState(props.rowVersion);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [historyKey, setHistoryKey] = useState(0);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (!save || !form.current) return;
    setStatus(null);
    const { data, errors: local } = read(form.current, fields);
    setErrors(local);
    if (Object.keys(local).length) {
      setStatus({ ok: false, text: 'Проверьте отмеченные поля.' });
      return;
    }
    let body: Record<string, unknown>;
    if (save.method === 'PATCH') {
      body = Object.fromEntries(Object.entries(data).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial.current[k] ?? null)));
      if (Object.keys(body).length === 0) {
        setStatus({ ok: true, text: 'Изменений нет.' });
        return;
      }
      if (save.versioned) body.rowVersion = rowVersion;
    } else {
      body = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
    }
    setBusy(true);
    try {
      const saved = await browserCall<Record<string, unknown>>(save.path, { method: save.method, body });
      markClean(form.current);
      if (save.redirect) {
        location.assign(fill(save.redirect, saved));
        return;
      }
      initial.current = { ...initial.current, ...data };
      if (typeof saved.rowVersion === 'number') setRowVersion(saved.rowVersion);
      setStatus({ ok: true, text: 'Сохранено.' });
      setHistoryKey((k) => k + 1);
    } catch (err) {
      const issues = err instanceof ApiError ? (err.details?.issues as Array<{ path: string; message: string }> | undefined) : undefined;
      if (issues?.length) {
        setErrors(Object.fromEntries(issues.map((i) => [i.path.split('.')[0]!, i.message])));
        setStatus({ ok: false, text: 'Проверьте отмеченные поля.' });
      } else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        setStatus({ ok: false, text: 'Запись уже изменил другой сотрудник. Обновите страницу – ваши правки придётся внести заново.' });
      } else {
        setStatus({ ok: false, text: `Не сохранено: ${errorText(err)}.` });
      }
    } finally {
      setBusy(false);
    }
  };

  const archiveOp = async (path: string | undefined) => {
    if (!path) return;
    setRemoveError('');
    setBusy(true);
    try {
      await browserCall(path, { method: 'POST', body: remove?.versioned ? { rowVersion } : {} });
      markClean(form.current);
      location.reload();
    } catch (err) {
      setRemoveError(`Не получилось: ${errorText(err)}.`);
      setBusy(false);
    }
  };

  return (
    <>
      {!props.historyOnly && <section class="yc-panel" aria-label="Карточка">
        <form class="yc-form yc-form--wide" ref={form} data-guard={save ? '' : undefined} novalidate onSubmit={onSubmit}>
          {fields.map((f) => (
            <Field key={f.name} f={save ? f : { ...f, readOnly: true }} value={props.values[f.name]} error={errors[f.name]} />
          ))}
          <p class={`yc-alert ${status ? (status.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">
            {status?.text ?? ''}
          </p>
          {save && (
            <div>
              <button class="yc-btn" type="submit" disabled={busy}>
                {busy ? 'Сохранение…' : save.label}
              </button>
            </div>
          )}
        </form>
      </section>}

      {remove && (
        <section class="yc-panel" aria-labelledby="remove-title">
          <h2 id="remove-title">{remove.archived ? 'Запись в архиве' : 'Удаление'}</h2>
          {remove.archived ? (
            <>
              <p>{remove.what} в архиве: не показывается в рабочих списках, история сохранена.</p>
              {remove.restorePath && (
                <div>
                  <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void archiveOp(remove.restorePath)}>
                    Вернуть из архива
                  </button>
                </div>
              )}
            </>
          ) : (
            <div>
              <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" onClick={() => dialog.current?.showModal()}>
                Удалить…
              </button>
            </div>
          )}
          <p class="yc-alert yc-alert--error" role="alert">{remove.archived ? removeError : ''}</p>
        </section>
      )}

      {remove && !remove.archived && (
        <dialog ref={dialog} class="yc-dialog" aria-labelledby="remove-dialog-title">
          <div class="yc-dialog__body">
            <h2 id="remove-dialog-title">{remove.blocked ? 'Удалить нельзя' : 'Удалить запись?'}</h2>
            {remove.blocked ? (
              <p>{remove.blocked}</p>
            ) : (
              <p>
                Насовсем {remove.what.toLowerCase()} не удаляется: на запись ссылаются история и отчёты. Можно отправить в
                архив – запись пропадёт из рабочих списков и останется в разделе «Архив», откуда её можно вернуть.
              </p>
            )}
            <p class="yc-alert yc-alert--error" role="alert">{removeError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" autofocus onClick={() => dialog.current?.close()}>
                {remove.blocked ? 'Понятно' : 'Отмена'}
              </button>
              {!remove.blocked && (
                <button type="button" class="yc-btn yc-btn--danger" disabled={busy} onClick={() => void archiveOp(remove.archivePath)}>
                  В архив
                </button>
              )}
            </div>
          </div>
        </dialog>
      )}

      {history && <History h={history} fields={fields} reloadKey={historyKey} />}
    </>
  );
}
