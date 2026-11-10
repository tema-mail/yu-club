// «Расписание сотрудников» (S3-71, 05 §12.2, K18 №301–302, №307): календарь по филиалу или по сотруднику, день/неделя/месяц, фильтр по статусу, пустые интервалы
// покрытия (видны и у частично закрытого дня), создание смены. Конфликт времени (SHIFT_OVERLAP) подсвечивает смену и не сохраняется: гарантия – база на сервере.
// Время – по зоне филиала смены, не браузера. Администратор видит, кто работает, без сумм; сумм здесь нет ни у кого – они в карточке смены и в «Зарплате».
// Администратору /staff закрыт: имя коллеги приходит в самой смене (staffName, имя и фамилия – K18 №301), без контактов и ставок.
import { useEffect, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { addDays, fmtDay, inZone, zonedIso } from '../lib/booking.ts';
import { useLatest } from '../lib/latest.ts';
import { addMonths, mondayOf, monthEnd, monthStart, monthTitle, SHIFT_STATUS, shiftError, type CoverageDto, type Interval, type ShiftDto, type ShiftStatus } from '../lib/shifts.ts';

export interface CalBranch { id: string; name: string; timezone: string }
export interface ShiftCalendarProps {
  branches: CalBranch[];
  staff: Array<{ id: string; name: string }>;
  meId: string;
  meName: string;
  initialBranchId: string;
  today: string;
  canManage: boolean;
  canStaffCard: boolean;
}
type Mode = 'day' | 'week' | 'month';
const MODES: Array<[Mode, string]> = [['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц']];
const STATE: Record<CoverageDto['state'], { text: string; cls: string }> = {
  full: { text: 'Закрыто сменами', cls: 'yc-badge--active' },
  partial: { text: 'Есть пустые интервалы', cls: 'yc-badge--temporarily_closed' },
  empty: { text: 'Смены не запланированы', cls: 'yc-badge--bk-no_show' },
  closed: { text: 'Филиал закрыт', cls: 'yc-badge--archived' },
};
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Draft { staffId: string; branchId: string; date: string; start: string; end: string; comment: string }

export default function ShiftCalendar({ branches, staff, meId, meName, initialBranchId, today, canManage, canStaffCard }: ShiftCalendarProps) {
  const [by, setBy] = useState<'branch' | 'staff'>('branch');
  const [branchId, setBranchId] = useState(initialBranchId);
  const [staffId, setStaffId] = useState(staff[0]?.id ?? '');
  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState(today);
  const [status, setStatus] = useState<'' | ShiftStatus>('');
  const [shifts, setShifts] = useState<ShiftDto[]>([]);
  const [coverage, setCoverage] = useState<CoverageDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft>({ staffId: staff[0]?.id ?? '', branchId: initialBranchId, date: today, start: '10:00', end: '14:00', comment: '' });
  const [dlgError, setDlgError] = useState('');
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enc = encodeURIComponent;
  const tzOf = (id: string) => branches.find((b) => b.id === id)?.timezone ?? 'UTC';
  const nameOf = (s: ShiftDto) => (s.staffId === meId ? meName : (staff.find((x) => x.id === s.staffId)?.name ?? s.staffName ?? ''));
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Филиал';
  const hm = (iso: string, tz: string) => inZone(iso, tz).hm;

  const from = mode === 'day' ? anchor : mode === 'week' ? mondayOf(anchor) : monthStart(anchor);
  const to = mode === 'day' ? anchor : mode === 'week' ? addDays(mondayOf(anchor), 6) : monthEnd(anchor);
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);

  const latest = useLatest(); // листание и фильтры: ответ прежнего запроса не подменяет свежий календарь
  const load = async () => {
    const fresh = latest();
    setLoading(true);
    setError('');
    try {
      const scope = by === 'branch' ? `branchIds=${enc(branchId)}` : `staffId=${enc(staffId)}`;
      const [list, cov] = await Promise.all([
        browserCall<{ items: ShiftDto[] }>(`/shifts?${scope}&from=${from}&to=${to}${status ? `&status=${status}` : ''}`),
        by === 'branch' ? browserCall<CoverageDto[]>(`/shifts/coverage?branchIds=${enc(branchId)}&from=${from}&to=${to}`) : Promise.resolve([] as CoverageDto[]),
      ]);
      if (!fresh()) return;
      setShifts(list.items);
      setCoverage(cov);
    } catch (e) {
      if (!fresh()) return;
      setError(shiftError(e));
      setShifts([]);
      setCoverage([]);
    } finally {
      if (fresh()) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [by, branchId, staffId, from, to, status]);

  const shift = (dir: -1 | 1) => setAnchor(mode === 'day' ? addDays(anchor, dir) : mode === 'week' ? addDays(anchor, 7 * dir) : addMonths(anchor, dir));
  const title = mode === 'month' ? monthTitle(anchor) : mode === 'day' ? fmtDay(anchor, 'long') : `${fmtDay(from)} – ${fmtDay(to)}`;

  const dlg = () => document.getElementById('shift-create') as HTMLDialogElement | null;
  const openCreate = (date = anchor, gap?: Interval) => {
    const tz = tzOf(branchId);
    setDraft({
      staffId: by === 'staff' ? staffId : (staff[0]?.id ?? ''),
      branchId: by === 'branch' ? branchId : (branches[0]?.id ?? ''),
      date,
      start: gap ? hm(gap.start, tz) : '10:00',
      end: gap ? hm(gap.end, tz) : '14:00',
      comment: '',
    });
    setDlgError('');
    setConflict(null);
    dlg()?.showModal();
  };
  const save = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const tz = tzOf(draft.branchId);
    setBusy(true);
    setDlgError('');
    setConflict(null);
    try {
      await browserCall('/shifts', {
        method: 'POST',
        body: { staffId: draft.staffId, branchId: draft.branchId, start: zonedIso(draft.date, draft.start, tz), end: zonedIso(draft.date, draft.end, tz), ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}) },
      });
      dlg()?.close();
      await load();
    } catch (err) {
      setDlgError(shiftError(err));
      if (err instanceof ApiError && err.code === 'SHIFT_OVERLAP' && typeof err.details?.conflictShiftId === 'string') setConflict(err.details.conflictShiftId);
    } finally {
      setBusy(false);
    }
  };
  const put = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const covOf = (date: string) => coverage.find((c) => c.date === date);
  const inDay = (date: string) => shifts.filter((s) => s.localDate === date);

  const dayBlock = (date: string) => {
    const cov = covOf(date);
    const list = inDay(date);
    return (
      <article class="yc-sh-day" key={date} data-testid="shift-day" data-date={date}>
        <header class="yc-sh-day__head">
          <strong>{fmtDay(date)}</strong>
          {cov && <span class={`yc-badge ${STATE[cov.state].cls}`} data-testid="coverage-state">{STATE[cov.state].text}</span>}
        </header>
        {list.length === 0 && !cov && <p class="yc-empty">Смены не запланированы.</p>}
        <ul class="yc-sh-list">
          {list.map((s) => (
            <li key={s.id} class={`yc-sh-item${conflict === s.id ? ' yc-sh-item--conflict' : ''}`} data-testid="shift-item" data-shift={s.id}>
              <a class="yc-sh-item__time" href={`/shifts/${enc(s.id)}`}>{hm(s.plannedStart, s.timezone)}–{hm(s.plannedEnd, s.timezone)}</a>
              {canStaffCard ? <a href={`/staff/${enc(s.staffId)}`}>{nameOf(s)}</a> : <span data-testid="shift-staff">{nameOf(s)}</span>}
              {by === 'staff' && <span class="yc-field__hint">{branchName(s.branchId)}</span>}
              <span class={`yc-badge ${SHIFT_STATUS[s.status].cls}`}>{SHIFT_STATUS[s.status].text}</span>
              {s.flags.outsideHours && <span class="yc-field__hint">вне графика</span>}
            </li>
          ))}
        </ul>
        {cov && cov.gaps.length > 0 && (
          <ul class="yc-sh-list">
            {cov.gaps.map((g) => (
              <li key={g.start} class="yc-sh-gap" data-testid="coverage-gap">
                <span>Пусто {hm(g.start, cov.timezone)}–{hm(g.end, cov.timezone)}</span>
                {canManage && <button type="button" class="yc-link" onClick={() => openCreate(date, g)}>Поставить смену</button>}
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  };

  const monthGrid = () => {
    const pad = (new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7;
    return (
      <div class="yc-sh-month" data-testid="shift-month">
        {WEEKDAYS.map((w) => <span key={w} class="yc-sh-month__wd">{w}</span>)}
        {Array.from({ length: pad }, (_, i) => <span key={`pad${i}`} />)}
        {dates.map((date) => {
          const cov = covOf(date);
          const count = inDay(date).length;
          const gaps = cov ? cov.gaps.length : 0;
          return (
            <button type="button" key={date} class={`yc-sh-tile${gaps > 0 ? ' yc-sh-tile--gap' : ''}${date === today ? ' yc-sh-tile--today' : ''}`} data-testid="month-tile" data-date={date}
              aria-label={`${fmtDay(date, 'long')}: смен ${count}${gaps > 0 ? `, пустых интервалов ${gaps}` : ''}`}
              onClick={() => { setAnchor(date); setMode('day'); }}>
              <span>{Number(date.slice(8))}</span>
              <small>{count > 0 ? count : '–'}</small>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <section class="yc-panel yc-cal" aria-label="Расписание сотрудников" data-testid="shift-calendar">
      <div class="yc-board__bar">
        {staff.length > 0 && (
          <div class="yc-seg" role="group" aria-label="Календарь">
            <button type="button" class="yc-seg__btn" aria-pressed={by === 'branch'} onClick={() => setBy('branch')}>По филиалу</button>
            <button type="button" class="yc-seg__btn" aria-pressed={by === 'staff'} onClick={() => setBy('staff')}>По сотруднику</button>
          </div>
        )}
        {by === 'branch' ? (
          <div class="yc-field">
            <label class="yc-field__label" for="cal-branch">Филиал</label>
            <select id="cal-branch" class="yc-input" value={branchId} onChange={(e) => setBranchId((e.currentTarget as HTMLSelectElement).value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        ) : (
          <div class="yc-field">
            <label class="yc-field__label" for="cal-staff">Сотрудник</label>
            <select id="cal-staff" class="yc-input" value={staffId} onChange={(e) => setStaffId((e.currentTarget as HTMLSelectElement).value)}>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
        <div class="yc-field">
          <label class="yc-field__label" for="cal-status">Статус</label>
          <select id="cal-status" class="yc-input" value={status} onChange={(e) => setStatus((e.currentTarget as HTMLSelectElement).value as '' | ShiftStatus)}>
            <option value="">Все</option>
            {(Object.keys(SHIFT_STATUS) as ShiftStatus[]).map((k) => <option key={k} value={k}>{SHIFT_STATUS[k].text}</option>)}
          </select>
        </div>
      </div>

      <div class="yc-cal__bar">
        <div class="yc-seg" role="group" aria-label="Масштаб">
          {MODES.map(([m, text]) => <button type="button" key={m} class="yc-seg__btn" aria-pressed={mode === m} onClick={() => setMode(m)}>{text}</button>)}
        </div>
        <div class="yc-cal__nav">
          <button type="button" class="yc-btn yc-btn--ghost" aria-label="Раньше" onClick={() => shift(-1)}>←</button>
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => setAnchor(today)}>Сегодня</button>
          <button type="button" class="yc-btn yc-btn--ghost" aria-label="Позже" onClick={() => shift(1)}>→</button>
          <span class="yc-cal__title" data-testid="cal-title">{title}</span>
        </div>
        {canManage && <button type="button" class="yc-btn" onClick={() => openCreate()}>Новая смена</button>}
      </div>

      <p class="yc-alert yc-alert--error" role="alert">{error}</p>
      {loading && <p class="yc-empty" role="status">Загрузка…</p>}
      {!loading && !error && (mode === 'month' ? monthGrid() : <div class={mode === 'week' ? 'yc-sh-week' : 'yc-sh-oneday'}>{dates.map(dayBlock)}</div>)}
      {!loading && !error && by === 'staff' && shifts.length === 0 && <p class="yc-empty" data-testid="no-shifts">У сотрудника нет смен в этом периоде.</p>}

      <dialog id="shift-create" class="yc-dialog yc-dialog--wide" aria-labelledby="shift-create-title">
        <form class="yc-dialog__body" novalidate onSubmit={save} data-testid="shift-form">
          <h2 id="shift-create-title">Новая смена</h2>
          <div class="yc-field">
            <label class="yc-field__label" for="sf-staff">Сотрудник</label>
            <select id="sf-staff" class="yc-input" value={draft.staffId} onChange={(e) => put({ staffId: (e.currentTarget as HTMLSelectElement).value })}>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="sf-branch">Филиал</label>
            <select id="sf-branch" class="yc-input" value={draft.branchId} onChange={(e) => put({ branchId: (e.currentTarget as HTMLSelectElement).value })}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div class="yc-field">
            <label class="yc-field__label" for="sf-date">Дата</label>
            <input id="sf-date" class="yc-input" type="date" value={draft.date} onInput={(e) => put({ date: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="yc-board__pair">
            <div class="yc-field">
              <label class="yc-field__label" for="sf-start">Начало</label>
              <input id="sf-start" class="yc-input" type="time" aria-invalid={conflict !== null} value={draft.start} onInput={(e) => put({ start: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="sf-end">Конец</label>
              <input id="sf-end" class="yc-input" type="time" aria-invalid={conflict !== null} value={draft.end} onInput={(e) => put({ end: (e.currentTarget as HTMLInputElement).value })} />
            </div>
          </div>
          <p class="yc-field__hint">Время – по зоне филиала: {tzOf(draft.branchId)}.</p>
          <div class="yc-field">
            <label class="yc-field__label" for="sf-comment">Комментарий</label>
            <textarea id="sf-comment" class="yc-input" rows={2} maxLength={2000} value={draft.comment} onInput={(e) => put({ comment: (e.currentTarget as HTMLTextAreaElement).value })} />
          </div>
          <p class="yc-alert yc-alert--error" role="alert" data-testid="shift-form-error">
            {dlgError}{conflict && <> <a href={`/shifts/${enc(conflict)}`}>Открыть смену, с которой конфликт</a></>}
          </p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dlg()?.close()}>Отмена</button>
            <button type="submit" class="yc-btn" disabled={busy}>Сохранить смену</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
