// «Моё расписание» (S3-72, K18 §4–§5, №301–305, №308): свои смены, создать и снять свою будущую, отметить приход и уход, баннер чужих правок с «ознакомлен».
// Сотрудник планирует в каждом филиале своего назначения (TC-15): пересечение с собственной сменой в любом филиале сервер не пропустит. Суммы здесь не показываем:
// Администратору API их не отдаёт (Q-108). Время – по зоне филиала смены. Двойное нажатие «Пришёл» – одна отметка: кнопка занята, сервер отвечает тем же результатом.
import { useEffect, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { addDays, fmtDay, inZone, zonedIso } from '../lib/booking.ts';
import { fmtDate, REVIEW_REASON, SHIFT_STATUS, shiftError, type ShiftChange, type ShiftDto } from '../lib/shifts.ts';

export interface MyScheduleProps {
  meId: string;
  branches: Array<{ id: string; name: string; timezone: string }>;
  today: string;
  staffNames: Record<string, string>;
}
const WINDOW_DAYS = 31; // предел GET /shifts
const WINDOW_BACK = 7;
/** Самое раннее окно прихода по настройке shift.checkin_early_minutes (до 240): точную проверку делает сервер. */
const CHECKIN_SHOW_MS = 240 * 60_000;
const KIND: Record<string, string> = { created: 'поставил вам смену', updated: 'изменил вашу смену', cancelled: 'отменил вашу смену' };

export default function MySchedule({ meId, branches, today, staffNames }: MyScheduleProps) {
  const [from, setFrom] = useState(addDays(today, -WINDOW_BACK));
  const to = addDays(from, WINDOW_DAYS - 1);
  const [shifts, setShifts] = useState<ShiftDto[]>([]);
  const [changes, setChanges] = useState<ShiftChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ branchId: branches[0]?.id ?? '', date: addDays(today, 2), start: '10:00', end: '14:00', comment: '' });
  const [dlgError, setDlgError] = useState('');
  const [target, setTarget] = useState<ShiftDto | null>(null);
  const [reason, setReason] = useState('');
  const enc = encodeURIComponent;
  const branchOf = (id: string | undefined) => branches.find((b) => b.id === id);
  const hm = (iso: string, tz: string) => inZone(iso, tz).hm;
  const newDlg = () => document.getElementById('my-new') as HTMLDialogElement | null;
  const offDlg = () => document.getElementById('my-off') as HTMLDialogElement | null;

  const load = async () => {
    setLoading(true);
    try {
      const [list, ch] = await Promise.all([
        browserCall<{ items: ShiftDto[] }>(`/shifts?staffId=${enc(meId)}&from=${from}&to=${to}`),
        browserCall<{ items: ShiftChange[] }>('/me/shift-changes?unread=true'),
      ]);
      setShifts(list.items);
      setChanges(ch.items);
    } catch (e) {
      setError(shiftError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [from]);

  const act = async (s: ShiftDto, what: 'check-in' | 'check-out') => {
    if (busy) return;
    setBusy(s.id);
    setError('');
    setNotice('');
    try {
      await browserCall(`/shifts/${enc(s.id)}/${what}`, { method: 'POST', body: {} });
      setNotice(what === 'check-in' ? 'Приход отмечен.' : 'Уход отмечен, смена отработана.');
      await load();
    } catch (e) {
      setError(shiftError(e));
    } finally {
      setBusy(null);
    }
  };
  const create = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const tz = branchOf(draft.branchId)?.timezone ?? 'UTC';
    setBusy('new');
    setDlgError('');
    try {
      await browserCall('/shifts', {
        method: 'POST',
        body: { staffId: meId, branchId: draft.branchId, start: zonedIso(draft.date, draft.start, tz), end: zonedIso(draft.date, draft.end, tz), ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}) },
      });
      newDlg()?.close();
      setNotice('Смена запланирована.');
      await load();
    } catch (err) {
      setDlgError(shiftError(err));
    } finally {
      setBusy(null);
    }
  };
  const openOff = (s: ShiftDto) => {
    setTarget(s);
    setReason('');
    setDlgError('');
    offDlg()?.showModal();
  };
  const takeOff = async (e: Event) => {
    e.preventDefault();
    if (busy || !target) return;
    setBusy('off');
    setDlgError('');
    try {
      await browserCall(`/shifts/${enc(target.id)}/cancel`, { method: 'POST', body: { rowVersion: target.rowVersion, reason: reason.trim() } });
      offDlg()?.close();
      setNotice('Смена снята.');
      await load();
    } catch (err) {
      setDlgError(shiftError(err));
    } finally {
      setBusy(null);
    }
  };
  const ack = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError('');
    try {
      await browserCall(`/me/shift-changes/${enc(id)}/ack`, { method: 'POST', body: {} });
      setChanges((list) => list.filter((c) => c.id !== id));
    } catch (e) {
      setError(shiftError(e));
    } finally {
      setBusy(null);
    }
  };
  const slot = (v: ShiftChange['before']) => {
    if (!v?.start || !v.end) return '';
    const tz = branchOf(v.branchId)?.timezone ?? branches[0]?.timezone ?? 'UTC';
    const start = inZone(v.start, tz);
    return `${fmtDate(start.date)} ${start.hm}–${hm(v.end, tz)}`;
  };
  const put = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const now = Date.now();

  return (
    <>
      {changes.length > 0 && (
        <section class="yc-alert yc-sh-banner" aria-label="Изменения ваших смен" data-testid="my-changes">
          <h2 class="yc-field__label">Руководитель менял ваши смены: {changes.length}</h2>
          <ul class="yc-sh-list">
            {changes.map((c) => (
              <li key={c.id} class="yc-sh-banner__row" data-testid="my-change">
                <span>
                  {staffNames[c.changedBy] ?? 'Руководитель'} {KIND[c.kind] ?? 'изменил смену'}
                  {c.before && <>: было {slot(c.before)}</>}{c.after && <>; стало {slot(c.after)}</>}
                  {c.reason && <>. Причина: {c.reason}</>}
                </span>
                <button type="button" class="yc-btn yc-btn--ghost" disabled={busy === c.id} onClick={() => void ack(c.id)}>Ознакомлен</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="yc-panel" aria-label="Мои смены" data-testid="my-schedule">
        <div class="yc-cal__bar">
          <div class="yc-cal__nav">
            <button type="button" class="yc-btn yc-btn--ghost" aria-label="Раньше" onClick={() => setFrom(addDays(from, -WINDOW_DAYS))}>←</button>
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => setFrom(addDays(today, -WINDOW_BACK))}>Сейчас</button>
            <button type="button" class="yc-btn yc-btn--ghost" aria-label="Позже" onClick={() => setFrom(addDays(from, WINDOW_DAYS))}>→</button>
            <span class="yc-cal__title">{fmtDate(from)} – {fmtDate(to)}</span>
          </div>
          <button type="button" class="yc-btn" onClick={() => { setDlgError(''); newDlg()?.showModal(); }}>Запланировать смену</button>
        </div>
        <p class="yc-alert yc-alert--ok" role="status" data-testid="my-notice">{notice}</p>
        <p class="yc-alert yc-alert--error" role="alert" data-testid="my-error">{error}</p>
        {loading && <p class="yc-empty" role="status">Загрузка…</p>}
        {!loading && shifts.length === 0 && <p class="yc-empty" data-testid="my-empty">Смены не запланированы. Запланируйте свою смену – не позже чем за 24 часа до начала.</p>}
        <ul class="yc-sh-list">
          {shifts.map((s) => {
            const start = Date.parse(s.plannedStart);
            const end = Date.parse(s.plannedEnd);
            const canIn = s.status === 'planned' && !s.factStart && now < end && now >= start - CHECKIN_SHOW_MS;
            const canOut = s.status === 'planned' && Boolean(s.factStart);
            const canOff = s.status === 'planned' && !s.factStart && start > now;
            return (
              <li key={s.id} class="yc-sh-my" data-testid="my-shift" data-shift={s.id}>
                <div class="yc-sh-my__main">
                  <a class="yc-sh-item__time" href={`/shifts/${enc(s.id)}`}>{fmtDay(s.localDate)}, {hm(s.plannedStart, s.timezone)}–{hm(s.plannedEnd, s.timezone)}</a>
                  <span>{branchOf(s.branchId)?.name ?? 'Филиал'}</span>
                  <span class={`yc-badge ${SHIFT_STATUS[s.status].cls}`}>{SHIFT_STATUS[s.status].text}</span>
                </div>
                {s.factStart && <span class="yc-field__hint">Приход {hm(s.factStart, s.timezone)}{s.factEnd ? `, уход ${hm(s.factEnd, s.timezone)}` : ''}</span>}
                {s.status === 'needs_review' && <span class="yc-field__hint">Проверит руководитель{s.flags.reviewReason ? `: ${REVIEW_REASON[s.flags.reviewReason] ?? s.flags.reviewReason}` : ''}.</span>}
                {(canIn || canOut || canOff) && (
                  <div class="yc-bk__actions">
                    {canIn && <button type="button" class="yc-btn" disabled={busy !== null} onClick={() => void act(s, 'check-in')}>Пришёл</button>}
                    {canOut && <button type="button" class="yc-btn" disabled={busy !== null} onClick={() => void act(s, 'check-out')}>Ушёл</button>}
                    {canOff && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => openOff(s)}>Снять смену</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <dialog id="my-new" class="yc-dialog yc-dialog--wide" aria-labelledby="my-new-title">
        <form class="yc-dialog__body" novalidate onSubmit={create} data-testid="my-form">
          <h2 id="my-new-title">Запланировать смену</h2>
          <div class="yc-field">
            <label class="yc-field__label" for="my-branch">Филиал</label>
            <select id="my-branch" class="yc-input" value={draft.branchId} onChange={(e) => put({ branchId: (e.currentTarget as HTMLSelectElement).value })}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="my-date">Дата</label>
            <input id="my-date" class="yc-input" type="date" value={draft.date} onInput={(e) => put({ date: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-board__pair">
            <div class="yc-field">
              <label class="yc-field__label" for="my-start">Начало</label>
              <input id="my-start" class="yc-input" type="time" value={draft.start} onInput={(e) => put({ start: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="my-end">Конец</label>
              <input id="my-end" class="yc-input" type="time" value={draft.end} onInput={(e) => put({ end: (e.currentTarget as HTMLInputElement).value })} />
            </div>
          </div>
          <p class="yc-field__hint">Время – по зоне филиала: {branchOf(draft.branchId)?.timezone}.</p>
          <div class="yc-field">
            <label class="yc-field__label" for="my-comment">Комментарий</label>
            <textarea id="my-comment" class="yc-input" rows={2} maxLength={2000} value={draft.comment} onInput={(e) => put({ comment: (e.currentTarget as HTMLTextAreaElement).value })} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert" data-testid="my-form-error">{dlgError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => newDlg()?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy !== null}>Запланировать</button>
          </div>
        </form>
      </dialog>

      <dialog id="my-off" class="yc-dialog" aria-labelledby="my-off-title">
        <form class="yc-dialog__body" novalidate onSubmit={takeOff}>
          <h2 id="my-off-title">Снять смену?</h2>
          {target && <p>{fmtDay(target.localDate, 'long')}, {hm(target.plannedStart, target.timezone)}–{hm(target.plannedEnd, target.timezone)}. Запись останется в истории со статусом «Отменена».</p>}
          <div class="yc-field">
            <label class="yc-field__label" for="my-off-reason">Причина *</label>
            <textarea id="my-off-reason" class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => offDlg()?.close()}>Не снимать</button>
            <button type="submit" class="yc-btn yc-btn--danger" disabled={busy !== null || !reason.trim()}>Снять смену</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
