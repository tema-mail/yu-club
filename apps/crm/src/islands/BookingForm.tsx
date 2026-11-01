// Бронь администратором (S1-23, K11 №4, K9 CrmCreateBooking): клиент из базы (поиск по телефону или фамилии)
// или без профиля – телефон и имя (сервер найдёт или заведёт карточку гостя). Проверки – на сервере теми же
// правилами, что у сайта: пересечение, блокировка, часы, шаг; отказ – понятным текстом, ввод не сбрасывается.
// ScheduleBoard – календарь расписания + окно новой записи: клик по свободному слоту подставляет место и время.
import { useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { addDays, bookingApi, bookingError, fmtRange, today, zonedIso, type CalendarDto, type CreateBody, type CrmBooking } from '../lib/booking.ts';
import BranchCalendar, { type CalendarView, type SlotPick } from './BranchCalendar.tsx';

interface ClientHit { id: string; status: string; firstName: string | null; lastName: string | null; phoneMasked: string }
const DURATIONS = [30, 60, 90, 120, 180, 240, 300];
const durLabel = (m: number) => (m % 60 === 0 ? `${m / 60} ч` : m > 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`);
const STATUS_HINT: Record<string, string> = { guest: 'гость', active: 'зарегистрирован', restricted: 'ограничен', blocked: 'заблокирован' };

export interface ScheduleBoardProps {
  branchId: string;
  timezone: string;
  view: CalendarView;
  date: string;
  initial: CalendarDto;
  canCreate: boolean;
  canSearchClients: boolean;
}

export default function ScheduleBoard(props: ScheduleBoardProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [slot, setSlot] = useState<SlotPick | null>(null);
  const [formKey, setFormKey] = useState(0);
  const open = (s: SlotPick | null) => {
    setSlot(s);
    setFormKey((k) => k + 1);
    dialog.current?.showModal();
  };
  return (
    <>
      {props.canCreate && (
        <div class="yc-board__bar">
          <button type="button" class="yc-btn" onClick={() => open(null)}>Новая запись</button>
          <span class="yc-field__hint">или нажмите на свободное время в ленте дня</span>
        </div>
      )}
      <BranchCalendar branchId={props.branchId} timezone={props.timezone} view={props.view} date={props.date} initial={props.initial}
        onSlot={props.canCreate ? open : undefined} />
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby="new-booking-title">
        <BookingForm key={formKey} branchId={props.branchId} timezone={props.timezone} resources={props.initial.resources} slot={slot}
          date={props.date} canSearchClients={props.canSearchClients} onClose={() => dialog.current?.close()} />
      </dialog>
    </>
  );
}

interface FormProps {
  branchId: string; timezone: string; resources: CalendarDto['resources']; slot: SlotPick | null; date: string; canSearchClients: boolean; onClose: () => void;
}

function BookingForm(p: FormProps) {
  const tz = p.timezone;
  const [mode, setMode] = useState<'guest' | 'client'>(p.canSearchClients ? 'client' : 'guest');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ClientHit[] | null>(null);
  const [searchMsg, setSearchMsg] = useState('');
  const [clientId, setClientId] = useState('');
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [resourceId, setResourceId] = useState(p.slot?.resourceId ?? p.resources[0]?.id ?? '');
  const [date, setDate] = useState(p.slot?.date ?? (p.date < today(tz) ? today(tz) : p.date));
  const [time, setTime] = useState(p.slot?.hm ?? '12:00');
  const [duration, setDuration] = useState(60);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CrmBooking | null>(null);

  const search = async () => {
    setSearchMsg('');
    setHits(null);
    setClientId('');
    const t = q.trim();
    if (t.length < 2) return setSearchMsg('Введите телефон (от 4 цифр) или фамилию.');
    try {
      const r = await browserCall<{ items: ClientHit[] }>(`/clients?q=${encodeURIComponent(t)}&limit=10`);
      setHits(r.items);
      if (r.items.length === 0) setSearchMsg('Никого не нашли. Проверьте ввод или запишите без профиля.');
      if (r.items.length === 1) setClientId(r.items[0]!.id);
    } catch (e) {
      setSearchMsg(`Поиск не удался: ${bookingError(e)}`);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return; // двойной клик – одна операция
    setError('');
    let client: CreateBody['client'];
    if (mode === 'client') {
      if (!clientId) return setError('Выберите клиента из найденных или переключитесь на «Без профиля».');
      client = { clientId };
    } else {
      if (phone.replace(/\D/g, '').length < 10) return setError('Укажите телефон клиента полностью, например +7 913 123-45-67.');
      if (!firstName.trim()) return setError('Укажите имя клиента.');
      client = { phone: phone.trim(), firstName: firstName.trim(), ...(lastName.trim() ? { lastName: lastName.trim() } : {}) };
    }
    if (!resourceId) return setError('Выберите место.');
    if (!/^\d{2}:\d{2}$/.test(time) || !date) return setError('Укажите дату и время начала.');
    const start = zonedIso(date, time, tz);
    const end = new Date(Date.parse(start) + duration * 60_000).toISOString();
    if (Date.parse(start) <= Date.now()) return setError('Это время уже прошло – выберите будущее.');
    setBusy(true);
    try {
      const b = await bookingApi.create(p.branchId, { resourceId, start, end, client, ...(comment.trim() ? { internalComment: comment.trim() } : {}) });
      setCreated(b);
    } catch (err) {
      setError(`Запись не создана. ${bookingError(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div class="yc-dialog__body" role="status" data-testid="booking-created">
        <h2 id="new-booking-title">Запись №{created.number} создана</h2>
        <p>{created.resourceName}, {fmtRange(created.start, created.end, tz)} · {created.client.name ?? 'Без имени'} {created.client.phoneMasked}</p>
        <div class="yc-dialog__actions">
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => location.reload()}>Закрыть</button>
          <a class="yc-btn" href={`/bookings/${encodeURIComponent(created.id)}`}>Открыть запись</a>
        </div>
      </div>
    );
  }

  const set = (f: (v: string) => void) => (e: Event) => f((e.currentTarget as HTMLInputElement).value);
  return (
    <form class="yc-dialog__body" novalidate onSubmit={submit}>
      <h2 id="new-booking-title">Новая запись</h2>
      {p.canSearchClients && (
        <div class="yc-seg" role="group" aria-label="Клиент">
          <button type="button" class="yc-seg__btn" aria-pressed={mode === 'client'} onClick={() => setMode('client')}>Клиент из базы</button>
          <button type="button" class="yc-seg__btn" aria-pressed={mode === 'guest'} onClick={() => setMode('guest')}>Без профиля</button>
        </div>
      )}
      {mode === 'client' ? (
        <fieldset class="yc-week">
          <legend class="yc-field__label">Поиск клиента</legend>
          <div class="yc-board__search">
            <input class="yc-input" aria-label="Телефон или фамилия" placeholder="Телефон или фамилия" value={q} onInput={set(setQ)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void search())} />
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void search()}>Найти</button>
          </div>
          {searchMsg && <p class="yc-field__hint" role="status">{searchMsg}</p>}
          {hits && hits.length > 0 && (
            <div class="yc-board__hits" role="radiogroup" aria-label="Найденные клиенты">
              {hits.map((c) => (
                <label class="yc-check" key={c.id}>
                  <input type="radio" name="client" checked={clientId === c.id} onChange={() => setClientId(c.id)} />
                  {[c.firstName, c.lastName].filter((x) => x).join(' ') || 'Без имени'} · {c.phoneMasked} · {STATUS_HINT[c.status] ?? c.status}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ) : (
        <>
          <div class="yc-field">
            <label class="yc-field__label" for="nb-phone">Телефон *</label>
            <input id="nb-phone" class="yc-input" type="tel" inputMode="tel" autoComplete="off" placeholder="+7 913 123-45-67" value={phone} onInput={set(setPhone)} />
            <span class="yc-field__hint">Есть карточка с этим телефоном – запись попадёт в неё, нет – заведём карточку гостя.</span>
          </div>
          <div class="yc-board__pair">
            <div class="yc-field">
              <label class="yc-field__label" for="nb-first">Имя *</label>
              <input id="nb-first" class="yc-input" autoComplete="off" value={firstName} onInput={set(setFirstName)} />
            </div>
            <div class="yc-field">
              <label class="yc-field__label" for="nb-last">Фамилия</label>
              <input id="nb-last" class="yc-input" autoComplete="off" value={lastName} onInput={set(setLastName)} />
            </div>
          </div>
        </>
      )}
      <div class="yc-field">
        <label class="yc-field__label" for="nb-res">Место</label>
        <select id="nb-res" class="yc-input" value={resourceId} onChange={set(setResourceId)}>
          {p.resources.map((r) => <option value={r.id} key={r.id}>{r.name}{r.roomName ? ` · ${r.roomName}` : ''}</option>)}
        </select>
      </div>
      <div class="yc-board__pair">
        <div class="yc-field">
          <label class="yc-field__label" for="nb-date">Дата</label>
          <input id="nb-date" class="yc-input" type="date" min={today(tz)} max={addDays(today(tz), 60)} value={date} onInput={set(setDate)} />
        </div>
        <div class="yc-field">
          <label class="yc-field__label" for="nb-time">Начало</label>
          <input id="nb-time" class="yc-input" type="time" step={900} value={time} onInput={set(setTime)} />
        </div>
      </div>
      <div class="yc-field">
        <label class="yc-field__label" for="nb-dur">Длительность</label>
        <select id="nb-dur" class="yc-input" value={String(duration)} onChange={(e) => setDuration(Number((e.currentTarget as HTMLSelectElement).value))}>
          {DURATIONS.map((m) => <option value={String(m)} key={m}>{durLabel(m)}</option>)}
        </select>
      </div>
      <div class="yc-field">
        <label class="yc-field__label" for="nb-comment">Служебный комментарий</label>
        <input id="nb-comment" class="yc-input" maxLength={1000} value={comment} onInput={set(setComment)} />
        <span class="yc-field__hint">Видят только сотрудники. Время – филиала ({tz}).</span>
      </div>
      <p class="yc-alert yc-alert--error" role="alert">{error}</p>
      <div class="yc-dialog__actions">
        <button type="button" class="yc-btn yc-btn--ghost" onClick={p.onClose}>Отмена</button>
        <button type="submit" class="yc-btn" disabled={busy}>{busy ? 'Создаём…' : 'Записать'}</button>
      </div>
    </form>
  );
}
