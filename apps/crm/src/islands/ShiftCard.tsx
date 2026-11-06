// Карточка смены (S3-73, 05 §12.3, K18 §4–§5, №303–306): план и факт, ручные минуты с обязательным комментарием, невыход, «не оплачивается», перенос и отмена – окнами внутри
// записи, история (timeline): суммы без права приходят от сервера маской. Плановая смена не становится фактом сама. Суммы – только то, что отдал сервер: null без права не показываем,
// null при праве и rateMissing – «Не настроена ставка оплаты», не ноль. Время – по зоне филиала смены. Закрытый период – сервер отвечает PAYROLL_PERIOD_CLOSED: показываем текст.
import { useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { inZone, zonedIso } from '../lib/booking.ts';
import { fmtDate, fmtMinutes, REVIEW_REASON, SHIFT_STATUS, shiftError, type ShiftDto, type TimelineEvent } from '../lib/shifts.ts';
import { rub } from './CashJournal.tsx';

export interface ShiftCardProps {
  initial: ShiftDto;
  initialTimeline: TimelineEvent[];
  staffName: string;
  branches: Array<{ id: string; name: string; timezone: string }>;
  staffNames: Record<string, string>;
  meId: string;
  /** shift.attendance.correct: факт, минуты, невыход. */
  canCorrect: boolean;
  /** shift.plan.own для своей, shift.manage для чужой: перенос и отмена. */
  canEdit: boolean;
  /** payroll.view: суммы и пометка ставки. */
  canMoney: boolean;
}
const ACTION: Record<string, string> = {
  'shift.created': 'Смена создана',
  'shift.updated': 'Смена изменена',
  'shift.cancelled': 'Смена отменена',
  'shift.attendance_set': 'Изменён факт выхода',
  'shift.change_acknowledged': 'Сотрудник ознакомлен',
  'payroll.correction.posted': 'Корректировка',
};
const FIELD: Record<string, string> = {
  start: 'Начало', end: 'Конец', branchId: 'Филиал', status: 'Статус', factStart: 'Приход', factEnd: 'Уход', paidMinutes: 'Оплачиваемые минуты',
  unpaidConfirmed: 'Не оплачивается', comment: 'Комментарий', amountKop: 'Сумма', outsideHours: 'Вне графика',
};
type Dlg = 'noshow' | 'unpaid' | 'move' | 'cancel';
const TITLE: Record<Dlg, string> = { noshow: 'Отметить невыход?', unpaid: 'Смена не оплачивается?', move: 'Перенести смену', cancel: 'Отменить смену?' };
const TEXT: Partial<Record<Dlg, string>> = {
  noshow: 'Плановая длительность не оплачивается, ставка за выход не начисляется.',
  unpaid: 'Смена без ставки перестанет блокировать закрытие периода и не будет начислена.',
  cancel: 'Запись останется со статусом «Отменена», начисление по ней снимется.',
};

export default function ShiftCard({ initial, initialTimeline, staffName, branches, staffNames, meId, canCorrect, canEdit, canMoney }: ShiftCardProps) {
  const [shift, setShift] = useState(initial);
  const [timeline, setTimeline] = useState(initialTimeline);
  const tz = shift.timezone;
  const hm = (iso: string, zone = tz) => inZone(iso, zone).hm;
  const [mode, setMode] = useState<'minutes' | 'time'>('time');
  const [factStart, setFactStart] = useState(hm(initial.factStart ?? initial.plannedStart));
  const [factEnd, setFactEnd] = useState(hm(initial.factEnd ?? initial.plannedEnd));
  const [minutes, setMinutes] = useState('');
  const [comment, setComment] = useState('');
  const [open, setOpen] = useState<Dlg | null>(null);
  const [reason, setReason] = useState('');
  const [move, setMove] = useState({ branchId: initial.branchId, date: initial.localDate, start: hm(initial.plannedStart), end: hm(initial.plannedEnd) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dlgError, setDlgError] = useState('');
  const [notice, setNotice] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const enc = encodeURIComponent;
  const url = `/shifts/${enc(shift.id)}`;
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Филиал';
  const own = shift.staffId === meId;
  const started = Date.parse(shift.plannedStart) <= Date.now();

  const reload = async () => {
    const [s, t] = await Promise.all([browserCall<ShiftDto>(url), browserCall<{ items: TimelineEvent[] }>(`${url}/timeline`)]);
    setShift(s);
    setTimeline(t.items);
  };
  const run = async (call: () => Promise<unknown>, ok: string, onError: (t: string) => void) => {
    if (busy) return false;
    setBusy(true);
    setNotice('');
    try {
      await call();
      setNotice(ok);
      await reload();
      return true;
    } catch (e) {
      onError(shiftError(e));
      await reload().catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const openDlg = (d: Dlg) => {
    setOpen(d);
    setReason('');
    setDlgError('');
    setMove({ branchId: shift.branchId, date: shift.localDate, start: hm(shift.plannedStart), end: hm(shift.plannedEnd) });
    dlg.current?.showModal();
  };
  const submitFact = async (e: Event) => {
    e.preventDefault();
    setError('');
    let body: Record<string, unknown>;
    if (mode === 'minutes') {
      if (!/^\d{1,4}$/.test(minutes.trim()) || Number(minutes) > 1440) return setError('Минуты – целое число от 0 до 1440.');
      body = { rowVersion: shift.rowVersion, status: 'worked', paidMinutes: Number(minutes), reason: comment.trim() };
    } else {
      body = { rowVersion: shift.rowVersion, status: 'worked', factStart: zonedIso(shift.localDate, factStart, tz), factEnd: zonedIso(shift.localDate, factEnd, tz), reason: comment.trim() };
    }
    const done = await run(() => browserCall(`${url}/attendance`, { method: 'POST', body }), 'Факт сохранён.', setError);
    if (done) {
      setComment('');
      setMinutes('');
    }
  };
  const submitDlg = async (e: Event) => {
    e.preventDefault();
    setDlgError('');
    const text = reason.trim();
    const v = shift.rowVersion;
    let done = false;
    if (open === 'noshow') done = await run(() => browserCall(`${url}/attendance`, { method: 'POST', body: { rowVersion: v, status: 'no_show', reason: text } }), 'Отмечен невыход.', setDlgError);
    if (open === 'unpaid') done = await run(() => browserCall(`${url}/attendance`, { method: 'POST', body: { rowVersion: v, unpaidConfirmed: true, reason: text } }), 'Смена отмечена как неоплачиваемая.', setDlgError);
    if (open === 'cancel') done = await run(() => browserCall(`${url}/cancel`, { method: 'POST', body: { rowVersion: v, reason: text } }), 'Смена отменена.', setDlgError);
    if (open === 'move') {
      const zone = branches.find((b) => b.id === move.branchId)?.timezone ?? tz;
      const body = { rowVersion: v, start: zonedIso(move.date, move.start, zone), end: zonedIso(move.date, move.end, zone), branchId: move.branchId, ...(text ? { reason: text } : {}) };
      done = await run(() => browserCall(url, { method: 'PATCH', body }), 'Смена перенесена.', setDlgError);
    }
    if (done) dlg.current?.close();
  };
  const valueOf = (key: string, v: unknown): string => {
    if (v === null || v === undefined) return '–';
    if (key === 'status' && typeof v === 'string') return v in SHIFT_STATUS ? SHIFT_STATUS[v as ShiftDto['status']].text : v;
    if (key === 'branchId' && typeof v === 'string') return branchName(v);
    if (key === 'paidMinutes' && typeof v === 'number') return fmtMinutes(v);
    if (typeof v === 'boolean') return v ? 'да' : 'нет';
    if (key.endsWith('Kop')) return typeof v === 'number' ? rub(v) : String(v); // маска сервера «сумма скрыта»
    if (['start', 'end', 'factStart', 'factEnd'].includes(key) && typeof v === 'string') {
      const z = inZone(v, tz);
      return `${fmtDate(z.date)} ${z.hm}`;
    }
    return String(v);
  };

  const editable = canEdit && shift.status !== 'cancelled' && (canCorrect || shift.status === 'planned' || shift.status === 'needs_review');
  const needReason = !own && open === 'move';
  const canSubmit = open === 'move' ? !needReason || reason.trim() !== '' : reason.trim() !== '';
  const status = SHIFT_STATUS[shift.status];

  return (
    <>
      <section class="yc-panel" aria-labelledby="sc-plan" data-testid="shift-card">
        <h2 id="sc-plan">Смена <span class={`yc-badge ${status.cls}`} data-testid="sc-status">{status.text}</span></h2>
        {canMoney && shift.flags.rateMissing && <p class="yc-alert yc-alert--error" data-testid="sc-rate-missing">Не настроена ставка оплаты. Задайте ставку в карточке сотрудника или подтвердите, что смена не оплачивается.</p>}
        {shift.status === 'needs_review' && <p class="yc-alert yc-alert--error" data-testid="sc-review">Требует проверки{shift.flags.reviewReason ? `: ${REVIEW_REASON[shift.flags.reviewReason] ?? shift.flags.reviewReason}` : ''}. Факт выхода не подтверждён.</p>}
        <dl class="yc-props">
          <dt>Сотрудник</dt><dd>{staffName}</dd>
          <dt>Филиал</dt><dd>{branchName(shift.branchId)}</dd>
          <dt>Дата</dt><dd>{fmtDate(shift.localDate)}</dd>
          <dt>План</dt><dd data-testid="sc-plan-time">{hm(shift.plannedStart)}–{hm(shift.plannedEnd)}, {fmtMinutes(shift.plannedMinutes)}{shift.flags.outsideHours ? ' (вне графика)' : ''}</dd>
          <dt>Факт</dt>
          <dd data-testid="sc-fact">
            {shift.factStart ? `${hm(shift.factStart)}–${shift.factEnd ? hm(shift.factEnd) : '…'}` : 'нет отметок'}
            {shift.paidMinutes !== null && `; к оплате ${fmtMinutes(shift.paidMinutes)}${shift.paidMinutesSource === 'manual' ? ' (вручную)' : ''}`}
          </dd>
          {canMoney && <><dt>Плановое начисление</dt><dd data-testid="sc-planned-kop">{shift.plannedAccrualKop === null ? 'нет ставки' : rub(shift.plannedAccrualKop)} <span class="yc-field__hint">прогноз</span></dd></>}
          {canMoney && <><dt>Фактическое начисление</dt><dd data-testid="sc-fact-kop">{shift.factAccrualKop === null ? 'не проведено' : rub(shift.factAccrualKop)}</dd></>}
          {shift.flags.unpaidConfirmed && <><dt>Оплата</dt><dd>подтверждено: смена не оплачивается</dd></>}
          {shift.comment && <><dt>Комментарий</dt><dd>{shift.comment}</dd></>}
        </dl>
        <p class="yc-alert yc-alert--ok" role="status" data-testid="sc-notice">{notice}</p>
        <p class="yc-alert yc-alert--error" role="alert" data-testid="sc-error">{error}</p>
        {(editable || (canCorrect && shift.status !== 'cancelled')) && (
          <div class="yc-bk__actions">
            {canCorrect && shift.status !== 'cancelled' && started && shift.status !== 'no_show' && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => openDlg('noshow')}>Невыход</button>}
            {canCorrect && shift.flags.rateMissing && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => openDlg('unpaid')}>Смена не оплачивается</button>}
            {editable && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => openDlg('move')}>Перенести</button>}
            {editable && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" onClick={() => openDlg('cancel')}>Отменить смену</button>}
          </div>
        )}
      </section>

      {canCorrect && shift.status !== 'cancelled' && started && (
        <section class="yc-panel" aria-labelledby="sc-fact-title" data-testid="sc-fact-form">
          <h2 id="sc-fact-title">Отметить факт</h2>
          <form class="yc-form" novalidate onSubmit={submitFact}>
            <div class="yc-seg" role="group" aria-label="Как отметить">
              <button type="button" class="yc-seg__btn" aria-pressed={mode === 'time'} onClick={() => setMode('time')}>По времени</button>
              <button type="button" class="yc-seg__btn" aria-pressed={mode === 'minutes'} onClick={() => setMode('minutes')}>Минуты вручную</button>
            </div>
            {mode === 'time' ? (
              <div class="yc-board__pair">
                <div class="yc-field">
                  <label class="yc-field__label" for="sc-in">Приход</label>
                  <input id="sc-in" class="yc-input" type="time" value={factStart} onInput={(e) => setFactStart((e.currentTarget as HTMLInputElement).value)} />
                </div>
                <div class="yc-field">
                  <label class="yc-field__label" for="sc-out">Уход</label>
                  <input id="sc-out" class="yc-input" type="time" value={factEnd} onInput={(e) => setFactEnd((e.currentTarget as HTMLInputElement).value)} />
                </div>
              </div>
            ) : (
              <div class="yc-field">
                <label class="yc-field__label" for="sc-min">Оплачиваемые минуты</label>
                <input id="sc-min" class="yc-input" inputMode="numeric" autocomplete="off" value={minutes} onInput={(e) => setMinutes((e.currentTarget as HTMLInputElement).value)} />
              </div>
            )}
            <div class="yc-field">
              <label class="yc-field__label" for="sc-comment">Комментарий *</label>
              <textarea id="sc-comment" class="yc-input" rows={2} maxLength={2000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLTextAreaElement).value)} />
            </div>
            <div><button type="submit" class="yc-btn" disabled={busy || comment.trim() === ''}>Сохранить факт</button></div>
          </form>
        </section>
      )}

      <section class="yc-panel" aria-labelledby="sc-hist" data-testid="sc-history">
        <h2 id="sc-hist">История</h2>
        {timeline.length === 0 ? <p class="yc-empty">Изменений пока нет.</p> : (
          <ul class="yc-history">
            {timeline.map((ev) => {
              const keys = [...new Set([...Object.keys(ev.before ?? {}), ...Object.keys(ev.after ?? {})])].filter((k) => FIELD[k] && (ev.before?.[k] ?? null) !== (ev.after?.[k] ?? null));
              const at = inZone(ev.at, tz);
              return (
                <li class="yc-history__item" key={ev.id} data-testid="sc-event">
                  <span class="yc-history__head"><strong>{ACTION[ev.action] ?? ev.action}</strong> · {fmtDate(at.date)} {at.hm} · {ev.actorId ? (ev.actorId === meId ? 'вы' : (staffNames[ev.actorId] ?? 'сотрудник')) : 'система'}</span>
                  {ev.reason && <span>Причина: {ev.reason}</span>}
                  {keys.length > 0 && (
                    <ul class="yc-history__changes">
                      {keys.map((k) => <li key={k}>{FIELD[k]}: {valueOf(k, ev.before?.[k])} → {valueOf(k, ev.after?.[k])}</li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <dialog ref={dlg} class="yc-dialog yc-dialog--wide" aria-labelledby="sc-dlg-title">
        {open && (
          <form class="yc-dialog__body" novalidate onSubmit={submitDlg} data-testid="sc-dialog">
            <h2 id="sc-dlg-title">{TITLE[open]}</h2>
            {TEXT[open] && <p>{TEXT[open]}</p>}
            {open === 'move' && (
              <>
                {branches.length > 1 && (
                  <div class="yc-field">
                    <label class="yc-field__label" for="sc-mv-branch">Филиал</label>
                    <select id="sc-mv-branch" class="yc-input" value={move.branchId} onChange={(e) => setMove({ ...move, branchId: (e.currentTarget as HTMLSelectElement).value })}>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                )}
                <div class="yc-field">
                  <label class="yc-field__label" for="sc-mv-date">Дата</label>
                  <input id="sc-mv-date" class="yc-input" type="date" value={move.date} onInput={(e) => setMove({ ...move, date: (e.currentTarget as HTMLInputElement).value })} />
                </div>
                <div class="yc-board__pair">
                  <div class="yc-field">
                    <label class="yc-field__label" for="sc-mv-start">Начало</label>
                    <input id="sc-mv-start" class="yc-input" type="time" value={move.start} onInput={(e) => setMove({ ...move, start: (e.currentTarget as HTMLInputElement).value })} />
                  </div>
                  <div class="yc-field">
                    <label class="yc-field__label" for="sc-mv-end">Конец</label>
                    <input id="sc-mv-end" class="yc-input" type="time" value={move.end} onInput={(e) => setMove({ ...move, end: (e.currentTarget as HTMLInputElement).value })} />
                  </div>
                </div>
              </>
            )}
            <div class="yc-field">
              <label class="yc-field__label" for="sc-reason">Причина{open === 'move' && own ? '' : ' *'}</label>
              <textarea id="sc-reason" class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
            </div>
            <p class="yc-alert yc-alert--error" role="alert" data-testid="sc-dlg-error">{dlgError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dlg.current?.close()}>Закрыть</button>
              <button type="submit" class={open === 'cancel' ? 'yc-btn yc-btn--danger' : 'yc-btn'} disabled={busy || !canSubmit}>Подтвердить</button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
