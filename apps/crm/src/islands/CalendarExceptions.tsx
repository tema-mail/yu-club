// График филиала и исключения календаря (S1-24, network/routes.ts + calendar.ts, 15 §6.5).
// Любое изменение – в два шага: предпросмотр (какие будущие брони окажутся вне часов) → сохранение с confirmedAffected.
// Брони автоматически не отменяются: список – для ручного решения. Если список за это время изменился, сервер отвечает
// 409 AFFECTED_CHANGED с новым списком – показываем его и просим подтвердить заново.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

interface HoursRow { weekday: number; open: string | null; close: string | null; closed: boolean; validFrom: string; validTo: string | null }
type Scope = { type: 'branch' } | { type: 'room' | 'resource'; id: string };
interface Exception { id: string; scope: Scope; date: string; kind: string; open: string | null; close: string | null; reason: string; status: 'active' | 'cancelled' }

export interface CalendarProps {
  branchId: string;
  timezone: string;
  canManage: boolean;
  rooms: Array<{ id: string; name: string }>;
  resources: Array<{ id: string; name: string }>;
}

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const KIND_LABEL: Record<string, string> = {
  closed: 'Закрыто', holiday: 'Праздник – закрыто', technical: 'Технический день – закрыто', short_day: 'Сокращённый день', special_hours: 'Особые часы',
};
const CLOSING = new Set(['closed', 'holiday', 'technical']);
const errorText = (e: unknown) => (e instanceof ApiError ? e.message.replace(/\.$/, '') : 'Неизвестная ошибка');
const ruDate = (d: string) => d.split('-').reverse().join('.');

/** Сегодня и завтра по часам филиала (YYYY-MM-DD). */
function todayIn(tz: string, plusDays = 0): string {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return new Date(Date.parse(`${base}T00:00:00Z`) + plusDays * 86_400_000).toISOString().slice(0, 10);
}

/** Два шага «предпросмотр → подтверждение» для одного изменения. */
function useTwoStep(path: string, onDone: (result: unknown) => void) {
  const [affected, setAffected] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<Record<string, unknown>>({});
  const reset = () => {
    setAffected(null);
    setMsg(null);
  };
  const preview = async (b: Record<string, unknown>) => {
    reset();
    body.current = b;
    setBusy(true);
    try {
      const r = await browserCall<{ affectedBookingIds: string[] }>(`${path}/preview`, { method: 'POST', body: b });
      setAffected(r.affectedBookingIds);
    } catch (e) {
      setMsg({ ok: false, text: `Проверка не прошла: ${errorText(e)}.` });
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!affected) return;
    setBusy(true);
    try {
      const r = await browserCall<unknown>(path, { method: 'POST', body: { ...body.current, confirmedAffected: affected } });
      setAffected(null);
      setMsg({ ok: true, text: 'Сохранено.' });
      onDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AFFECTED_CHANGED') {
        setAffected((e.details?.affectedBookingIds as string[] | undefined) ?? []);
        setMsg({ ok: false, text: 'Пока вы смотрели, список затронутых броней изменился. Проверьте новый список и подтвердите снова.' });
      } else setMsg({ ok: false, text: `Не сохранено: ${errorText(e)}.` });
    } finally {
      setBusy(false);
    }
  };
  return { affected, msg, busy, preview, confirm, reset };
}

function Affected({ step, label, testId }: { step: ReturnType<typeof useTwoStep>; label: string; testId: string }) {
  return (
    <>
      <p class={`yc-alert ${step.msg ? (step.msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{step.msg?.text ?? ''}</p>
      {step.affected && (
        <div class="yc-panel" data-testid={testId}>
          {step.affected.length ? (
            <>
              <p><strong>Затронутые брони: {step.affected.length}.</strong> Они окажутся вне часов работы. Автоматически не отменяются – решите каждую вручную.</p>
              <ul>{step.affected.map((id) => <li key={id}>{id}</li>)}</ul>
            </>
          ) : (
            <p>Будущих броней это изменение не затрагивает.</p>
          )}
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={step.reset}>Отмена</button>
            <button type="button" class="yc-btn" disabled={step.busy} onClick={() => void step.confirm()}>
              {step.affected.length ? `${label}, затронуто: ${step.affected.length}` : label}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function CalendarExceptions(props: CalendarProps) {
  const { branchId, timezone, canManage } = props;
  const base = `/branches/${encodeURIComponent(branchId)}`;
  const [hours, setHours] = useState<HoursRow[] | null>(null);
  const [exceptions, setExceptions] = useState<Exception[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const today = todayIn(timezone);

  useEffect(() => {
    setLoadError('');
    Promise.all([
      browserCall<{ items: HoursRow[] }>(`${base}/hours`),
      browserCall<{ items: Exception[] }>(`${base}/calendar-exceptions?from=${today}&to=${todayIn(timezone, 365)}`),
    ])
      .then(([h, e]) => {
        setHours(h.items);
        setExceptions(e.items);
      })
      .catch((e: unknown) => setLoadError(errorText(e)));
  }, [reload]);

  // ---- недельный график
  const currentFor = (wd: number) =>
    (hours ?? []).filter((r) => r.weekday === wd && r.validFrom <= today && (!r.validTo || r.validTo >= today)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  const [validFrom, setValidFrom] = useState(todayIn(timezone, 1));
  const [days, setDays] = useState<Array<{ on: boolean; open: string; close: string }>>([]);
  useEffect(() => {
    if (hours) setDays(DAYS.map((_, i) => {
      const r = currentFor(i + 1);
      return { on: Boolean(r && !r.closed), open: r?.open ?? '10:00', close: r?.close ?? '22:00' };
    }));
  }, [hours]);
  const [note, setNote] = useState('');
  const weekly = useTwoStep(`${base}/hours`, () => setReload((n) => n + 1));
  const planned = (hours ?? []).filter((r) => r.validFrom > today);

  // ---- новое исключение
  const [ex, setEx] = useState({ date: today, scope: 'branch', kind: 'closed', open: '10:00', close: '18:00', reason: '' });
  const create = useTwoStep(`${base}/calendar-exceptions`, () => setReload((n) => n + 1));
  const scopeOf = (v: string): Scope => (v === 'branch' ? { type: 'branch' } : { type: v.startsWith('room:') ? 'room' : 'resource', id: v.slice(v.indexOf(':') + 1) });
  const scopeLabel = (s: Scope) =>
    s.type === 'branch' ? 'Весь филиал' : s.type === 'room' ? `Комната: ${props.rooms.find((r) => r.id === s.id)?.name ?? s.id}` : `Место: ${props.resources.find((r) => r.id === s.id)?.name ?? s.id}`;

  // ---- отмена исключения (окно внутри записи)
  const dialog = useRef<HTMLDialogElement>(null);
  const [cancelId, setCancelId] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const cancel = useTwoStep(`${base}/calendar-exceptions/${encodeURIComponent(cancelId)}/cancel`, () => {
    dialog.current?.close();
    setReload((n) => n + 1);
  });

  if (loadError) {
    return (
      <div class="yc-alert yc-alert--error yc-list__error" role="alert">
        <span>График не загрузился: {loadError}.</span>
        <button type="button" class="yc-btn yc-btn--ghost" onClick={() => setReload((n) => n + 1)}>Повторить</button>
      </div>
    );
  }
  if (!hours || !exceptions) return <p class="yc-empty" role="status">Загрузка…</p>;

  return (
    <>
      <section class="yc-panel" aria-labelledby="hours-title" data-testid="hours">
        <h2 id="hours-title">Недельный график</h2>
        <dl class="yc-props">
          {DAYS.map((d, i) => {
            const r = currentFor(i + 1);
            return <><dt>{d}</dt><dd>{r && !r.closed ? `${r.open}–${r.close}` : 'выходной'}</dd></>;
          })}
        </dl>
        {planned.length > 0 && (
          <p class="yc-field__hint" data-testid="hours-planned">
            Запланировано: {planned.map((r) => `${DAYS[r.weekday - 1]} с ${ruDate(r.validFrom)} – ${r.closed ? 'выходной' : `${r.open}–${r.close}`}`).join('; ')}
          </p>
        )}
        {canManage && (
          <form class="yc-form" novalidate onSubmit={(e) => {
            e.preventDefault();
            const changed = days
              .map((d, i) => ({ weekday: i + 1, open: d.on ? d.open : null, close: d.on ? d.close : null }))
              .filter((d) => {
                const r = currentFor(d.weekday);
                return !r || (r.closed ? d.open !== null : d.open !== r.open || d.close !== r.close);
              });
            if (changed.length === 0) {
              weekly.reset();
              setNote('Изменений нет – поменяйте часы хотя бы одного дня.');
              return;
            }
            setNote('');
            void weekly.preview({ validFrom, days: changed });
          }}>
            <h3>Изменить график</h3>
            <div class="yc-field">
              <label class="yc-field__label" for="hours-from">Действует с</label>
              <input id="hours-from" class="yc-input" type="date" min={todayIn(timezone, 1)} value={validFrom}
                onInput={(e) => { setValidFrom((e.currentTarget as HTMLInputElement).value); weekly.reset(); }} />
              <p class="yc-field__hint">Сегодняшний день меняется исключением, график – с завтрашней даты.</p>
            </div>
            <fieldset class="yc-week">
              <legend class="yc-field__label">Часы по дням</legend>
              {days.map((d, i) => (
                <div class="yc-week__day" key={i}>
                  <label class="yc-check">
                    <input type="checkbox" checked={d.on} onChange={(e) => { setDays(days.map((x, j) => (j === i ? { ...x, on: (e.currentTarget as HTMLInputElement).checked } : x))); weekly.reset(); }} />
                    {DAYS[i]}
                  </label>
                  <input class="yc-input" type="time" aria-label={`${DAYS[i]}, открытие`} value={d.open} disabled={!d.on}
                    onInput={(e) => { setDays(days.map((x, j) => (j === i ? { ...x, open: (e.currentTarget as HTMLInputElement).value } : x))); weekly.reset(); }} />
                  <span aria-hidden="true">–</span>
                  <input class="yc-input" type="time" aria-label={`${DAYS[i]}, закрытие`} value={d.close} disabled={!d.on}
                    onInput={(e) => { setDays(days.map((x, j) => (j === i ? { ...x, close: (e.currentTarget as HTMLInputElement).value } : x))); weekly.reset(); }} />
                </div>
              ))}
            </fieldset>
            <div><button type="submit" class="yc-btn yc-btn--ghost" disabled={weekly.busy}>Проверить затронутые брони</button></div>
            {note && <p class="yc-field__hint" role="status">{note}</p>}
          </form>
        )}
        <Affected step={weekly} label="Сохранить график" testId="hours-affected" />
      </section>

      <section class="yc-panel" aria-labelledby="exceptions-title" data-testid="exceptions">
        <h2 id="exceptions-title">Исключения на год вперёд</h2>
        {exceptions.length === 0 ? (
          <p class="yc-empty">Исключений нет – филиал работает по недельному графику.</p>
        ) : (
          <ul class="yc-history">
            {exceptions.map((e) => (
              <li class="yc-history__item" key={e.id}>
                <p class="yc-history__head">
                  <strong>{ruDate(e.date)}</strong> · {KIND_LABEL[e.kind] ?? e.kind}{e.open && e.close ? ` ${e.open}–${e.close}` : ''} · {scopeLabel(e.scope)}
                  {e.status === 'cancelled' && <> · <span class="yc-badge yc-badge--archived">Отменено</span></>}
                </p>
                <p>Причина: {e.reason}</p>
                {canManage && e.status === 'active' && e.date >= today && (
                  <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" onClick={() => {
                    setCancelId(e.id);
                    setCancelReason('');
                    cancel.reset();
                    dialog.current?.showModal();
                  }}>Отменить…</button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form class="yc-form" novalidate onSubmit={(e) => {
            e.preventDefault();
            void create.preview({
              scope: scopeOf(ex.scope), date: ex.date, exceptionKind: ex.kind, reason: ex.reason,
              ...(CLOSING.has(ex.kind) ? {} : { open: ex.open, close: ex.close }),
            });
          }}>
            <h3>Новое исключение</h3>
            <div class="yc-field">
              <label class="yc-field__label" for="ex-date">Дата</label>
              <input id="ex-date" class="yc-input" type="date" min={today} value={ex.date} onInput={(e) => { setEx({ ...ex, date: (e.currentTarget as HTMLInputElement).value }); create.reset(); }} />
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="ex-scope">Для чего</label>
              <select id="ex-scope" class="yc-input" value={ex.scope} onChange={(e) => { setEx({ ...ex, scope: (e.currentTarget as HTMLSelectElement).value }); create.reset(); }}>
                <option value="branch">Весь филиал</option>
                {props.rooms.map((r) => <option key={r.id} value={`room:${r.id}`}>Комната: {r.name}</option>)}
                {props.resources.map((r) => <option key={r.id} value={`resource:${r.id}`}>Место: {r.name}</option>)}
              </select>
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="ex-kind">Вид</label>
              <select id="ex-kind" class="yc-input" value={ex.kind} onChange={(e) => { setEx({ ...ex, kind: (e.currentTarget as HTMLSelectElement).value }); create.reset(); }}>
                {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            {!CLOSING.has(ex.kind) && (
              <div class="yc-week__day">
                <span>Часы</span>
                <input class="yc-input" type="time" aria-label="Открытие" value={ex.open} onInput={(e) => { setEx({ ...ex, open: (e.currentTarget as HTMLInputElement).value }); create.reset(); }} />
                <span aria-hidden="true">–</span>
                <input class="yc-input" type="time" aria-label="Закрытие" value={ex.close} onInput={(e) => { setEx({ ...ex, close: (e.currentTarget as HTMLInputElement).value }); create.reset(); }} />
              </div>
            )}
            <div class="yc-field">
              <label class="yc-field__label" for="ex-reason">Причина *</label>
              <input id="ex-reason" class="yc-input" value={ex.reason} maxLength={500} onInput={(e) => { setEx({ ...ex, reason: (e.currentTarget as HTMLInputElement).value }); create.reset(); }} />
            </div>
            <div><button type="submit" class="yc-btn yc-btn--ghost" disabled={create.busy}>Проверить затронутые брони</button></div>
          </form>
        )}
        <Affected step={create} label="Сохранить исключение" testId="exception-affected" />
      </section>

      <dialog ref={dialog} class="yc-dialog" aria-labelledby="cancel-ex-title">
        <div class="yc-dialog__body">
          <h2 id="cancel-ex-title">Отменить исключение?</h2>
          <p>Филиал в этот день снова будет работать по недельному графику. Запись останется в списке с пометкой «Отменено».</p>
          <div class="yc-field">
            <label class="yc-field__label" for="cancel-reason">Причина отмены *</label>
            <input id="cancel-reason" class="yc-input" value={cancelReason} maxLength={500} onInput={(e) => { setCancelReason((e.currentTarget as HTMLInputElement).value); cancel.reset(); }} />
          </div>
          {!cancel.affected && (
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" autofocus onClick={() => dialog.current?.close()}>Закрыть</button>
              <button type="button" class="yc-btn" disabled={cancel.busy} onClick={() => void cancel.preview({ reason: cancelReason })}>Проверить затронутые брони</button>
            </div>
          )}
          <Affected step={cancel} label="Отменить исключение" testId="cancel-affected" />
        </div>
      </dialog>
    </>
  );
}
