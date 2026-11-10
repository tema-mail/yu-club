// Подарок имениннику (S3-85, K20 §8, №376–378, 11 §9): выдача из карточки мероприятия (основание) или Владельцем вручную с причиной, запись подарка, блок
// в карточке клиента. Условия – дословно из снимка на выдаче. Выходные и праздники не предлагаются: дни считаются из срока, будней и GET /holidays;
// окна дня – GET /gifts/{id}/slots, окончательно решает сервер. Подарок – не сертификат: свой блок, свой номер GF-, без номинала (приёмка 19).
// Отмена – только Владелец и только без записи, окном внутри записи с причиной.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { addDays, inZone } from '../lib/booking.ts';
import { useLatest } from '../lib/latest.ts';
import { GIFT_BADGE, GIFT_STATUS, dayText, eventError, WEEKDAY, weekdayOf, type EventCardDto, type Gift, type GiftTerms, type Holiday } from '../lib/events.ts';
import { Modal, ReasonDialog } from './EventParts.tsx';

export interface GiftPanelProps {
  mode: 'event' | 'client';
  eventCard?: EventCardDto;
  clientId: string | null;
  actions: string[];
  branches: Array<{ id: string; name: string; cityId: string }>;
  defaultBranchId?: string | null;
  onChanged?: (notice?: string) => Promise<void>;
}

const CLOSED: Record<string, string> = {
  GIFT_EXPIRED: 'Срок подарка истёк к этой дате.', GIFT_WEEKDAY_ONLY: 'Подарок – только с понедельника по пятницу.', GIFT_HOLIDAY: 'В праздничный день подарок не действует.',
  RESOURCE_UNAVAILABLE: 'В этом филиале нет подарочного ресурса «2 VR».', OUTSIDE_BOOKING_WINDOW: 'Эта дата вне окна записи филиала.',
};
const NOT_INCLUDED: Record<string, string> = { PS4: 'PS4', 'PS VR': 'PS VR', food: 'еда' };

/** Условия дословно (11 §9.1): 2 устройства, по 30 минут, 40 минут комнаты, 60 дней, по записи, Пн–Пт кроме праздников; что не входит. */
export function giftTermsText(t: GiftTerms, days: number): string[] {
  return [
    `${t.devices} устройства ${t.device}`,
    `По ${t.minutesEach} минут на каждое устройство`,
    `Суммарная продолжительность использования комнаты – ${t.roomMinutes} минут с учётом подготовки`,
    `Срок действия – ${days} дней`,
    'Посещение по предварительной записи',
    `Доступность с понедельника по пятницу${t.excludesHolidays ? ', кроме праздничных дней' : ''}`,
    `${t.notIncluded.map((x) => NOT_INCLUDED[x] ?? x).join(', ').replace(/, ([^,]*)$/, ' и $1')} в подарок не входят`.replace(/^п/, 'П'),
  ];
}
const daysOf = (g: Gift) => Math.round((Date.parse(`${g.validUntil}T00:00:00Z`) - Date.parse(`${g.issuedOn}T00:00:00Z`)) / 86_400_000);

export default function GiftPanel(p: GiftPanelProps) {
  const [gifts, setGifts] = useState<Gift[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [manualBranch, setManualBranch] = useState(p.defaultBranchId ?? p.branches[0]?.id ?? '');
  const [cancelling, setCancelling] = useState<Gift | null>(null);
  const [booking, setBooking] = useState<Gift | null>(null);
  const [branchId, setBranchId] = useState('');
  const [days, setDays] = useState<string[]>([]);
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Array<{ start: string; end: string }> | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [slot, setSlot] = useState('');
  const [comment, setComment] = useState('');
  const [bookError, setBookError] = useState('');
  const key = useRef(crypto.randomUUID());
  const can = (a: string) => p.actions.includes(a);
  const event = p.eventCard;
  const list = (gifts ?? []).filter((g) => (event ? g.basisEventId === event.id || g.clientId === p.clientId : true));
  const hasLive = (gifts ?? []).some((g) => g.status !== 'cancelled');

  const load = async () => {
    if (!p.clientId) return setGifts([]);
    try {
      const r = await browserCall<{ items: Gift[] }>(`/gifts?clientId=${p.clientId}`);
      setGifts(r.items);
    } catch (err) {
      setError(eventError(err));
      setGifts([]);
    }
  };
  useEffect(() => void load(), [p.clientId]);

  // Основание по K20 §8.1: день рождения, именинник с профилем, статус «идёт» или «завершён» – иначе кнопка не обещает лишнего
  const eventIssueBlock = !event ? null
    : !['birthday_party', 'birthday'].includes(event.typeCode) ? 'Подарок выдаётся только за день рождения.'
      : !p.clientId ? 'У именинника нет профиля: укажите его на вкладке «Заказчик и участники» – иначе ему нечем записаться.'
        : !['in_progress', 'completed'].includes(event.status) ? 'Выдача – когда мероприятие идёт или завершено.'
          : !can('gift.issue') ? 'Нет права на выдачу подарка.' : null;
  const issue = async (reason: string | null, k: string) => {
    await browserCall<Gift>('/gifts', { method: 'POST', key: k, body: event ? { clientId: p.clientId, basisEventId: event.id } : { clientId: p.clientId, branchId: manualBranch, reason } });
    setIssuing(false);
    setNotice('Подарок выдан.');
    await load();
    await p.onChanged?.('Подарок выдан.');
  };

  // Смена филиала или дня: ответ прежнего не подменяет свежий – иначе окна одного дня показаны под другим и запись уходит не на тот день
  const daysLatest = useLatest();
  const slotsLatest = useLatest();
  const offerDays = async (g: Gift, b: string) => {
    const fresh = daysLatest();
    slotsLatest(); // окна прежнего филиала, если ещё в пути, уже не нужны
    const branch = p.branches.find((x) => x.id === b);
    setDays([]);
    setDate('');
    setSlots(null);
    setSlot('');
    const today = inZone(Date.now(), g.timezone).date;
    const from = today > g.issuedOn ? today : g.issuedOn;
    try {
      const q = new URLSearchParams({ from, to: g.validUntil, ...(branch ? { cityId: branch.cityId } : {}) });
      const r = await browserCall<{ items: Holiday[] }>(`/holidays?${q}`);
      if (!fresh()) return;
      const off = new Set(r.items.map((h) => h.date));
      const out: string[] = [];
      for (let d = from; d <= g.validUntil; d = addDays(d, 1)) {
        const w = weekdayOf(d);
        if (w !== 0 && w !== 6 && !off.has(d)) out.push(d);
      }
      setDays(out);
    } catch (err) {
      if (fresh()) setBookError(eventError(err));
    }
  };
  const openBook = (g: Gift) => {
    const b = p.branches.some((x) => x.id === g.issueBranchId) ? g.issueBranchId : (p.branches[0]?.id ?? '');
    setBooking(g);
    setBranchId(b);
    setComment('');
    setBookError('');
    key.current = crypto.randomUUID();
    void offerDays(g, b);
  };
  const pickDay = async (d: string) => {
    if (!booking) return;
    const fresh = slotsLatest();
    setDate(d);
    setSlot('');
    setSlots(null);
    setBookError('');
    if (!d) return;
    try {
      const r = await browserCall<{ closedReason: string | null; slots: Array<{ start: string; end: string }> }>(`/gifts/${booking.id}/slots?branchId=${branchId}&date=${d}`);
      if (!fresh()) return;
      setClosedReason(r.closedReason);
      setSlots(r.slots);
    } catch (err) {
      if (fresh()) setBookError(eventError(err));
    }
  };
  const book = async (e: Event) => {
    e.preventDefault();
    if (busy || !booking) return;
    if (!slot) return setBookError('Выберите время.');
    setBusy(true);
    setBookError('');
    try {
      await browserCall(`/gifts/${booking.id}/book`, { method: 'POST', key: key.current, body: { branchId, start: slot, clientId: booking.clientId, ...(comment.trim() ? { comment: comment.trim() } : {}) } });
      setBooking(null);
      setNotice('Подарок записан: бронь создана, клиент платит 0 ₽.');
      await load();
    } catch (err) {
      key.current = crypto.randomUUID();
      setBookError(eventError(err));
      if (date) await pickDay(date);
    } finally {
      setBusy(false);
    }
  };
  const fmtHm = (iso: string, tz: string) => inZone(iso, tz).hm;

  const body = (
    <>
      {notice && <p class="yc-alert yc-alert--ok" role="status" data-testid="gift-notice">{notice}</p>}
      {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      {gifts === null ? <p class="yc-empty">Загружаем…</p> : list.length === 0 ? <p class="yc-empty" data-testid="gift-empty">Подарков нет.</p> : (
        <ul class="yc-ev__cards" data-testid="gift-list">
          {list.map((g) => (
            <li class="yc-ev__item" key={g.id} data-testid={`gift-${g.number}`}>
              <div class="yc-ev__headline"><strong>{g.number}</strong><span class={`yc-badge yc-badge--${GIFT_BADGE[g.status]}`} data-testid="gift-status">{GIFT_STATUS[g.status]}</span></div>
              <span>Выдан {dayText(g.issuedOn)}, действует до {dayText(g.validUntil)} включительно. Филиал выдачи: {p.branches.find((b) => b.id === g.issueBranchId)?.name ?? 'другой филиал'}.</span>
              <ul class="yc-ev__terms" data-testid="gift-terms">{giftTermsText(g.terms, daysOf(g)).map((t) => <li key={t}>{t}</li>)}</ul>
              {g.basisEventId && p.mode === 'client' && <a href={`/events/${g.basisEventId}`}>Мероприятие-основание</a>}
              {g.bookingId && <a href={`/bookings/${g.bookingId}`} data-testid="gift-booking">Открыть запись</a>}
              {g.cancelReason && <span>Причина отмены: {g.cancelReason}</span>}
              <div class="yc-tabs">
                {g.status === 'issued' && can('gift.book') && <button class="yc-btn" type="button" onClick={() => openBook(g)}>Записать…</button>}
                {g.status === 'issued' && can('gift.cancel') && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setCancelling(g)}>Отменить…</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {event && (eventIssueBlock
        ? <p class="yc-field__hint" data-testid="gift-block">{eventIssueBlock}</p>
        : !hasLive && <div><button class="yc-btn" type="button" disabled={busy} onClick={() => { key.current = crypto.randomUUID(); setError(''); setIssuing(true); }}>Выдать подарок…</button></div>)}
      {!event && p.clientId && can('gift.issue.manual') && !hasLive && <div><button class="yc-btn yc-btn--ghost" type="button" onClick={() => setIssuing(true)}>Выдать без мероприятия…</button></div>}
      {!event && <p class="yc-field__hint">Подарок выдаётся из карточки мероприятия-основания. Это не сертификат: номинала нет, передать другому нельзя.</p>}

      {event ? (
        <Modal open={issuing} title="Выдать подарок имениннику?" onClose={() => setIssuing(false)} testId="gift-issue">
          <p>Один подарок на именинника в год. Срок считается от сегодняшней даты филиала.</p>
          <ul class="yc-ev__terms">{['2 устройства Meta Quest 3S', 'По 30 минут на каждое устройство', 'Суммарная продолжительность использования комнаты – 40 минут с учётом подготовки', 'Срок действия – 60 дней', 'Посещение по предварительной записи', 'Доступность с понедельника по пятницу, кроме праздничных дней', 'PS4, PS VR и еда в подарок не входят'].map((t) => <li key={t}>{t}</li>)}</ul>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setIssuing(false)}>Назад</button>
            <button class="yc-btn" type="button" disabled={busy} onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await issue(null, key.current);
              } catch (err) {
                key.current = crypto.randomUUID();
                setIssuing(false);
                setError(eventError(err));
              } finally {
                setBusy(false);
              }
            }}>Выдать</button>
          </div>
        </Modal>
      ) : (
        <ReasonDialog open={issuing} title="Выдать подарок без мероприятия" label="Причина" confirm="Выдать" testId="gift-issue-manual" onClose={() => setIssuing(false)} onConfirm={(r, k) => issue(r, k)}
          text={<label class="yc-field"><span class="yc-field__label">Филиал выдачи</span><select class="yc-input" value={manualBranch} onChange={(e) => setManualBranch(e.currentTarget.value)}>{p.branches.map((b) => <option value={b.id}>{b.name}</option>)}</select></label>} />
      )}
      <ReasonDialog open={cancelling !== null} title={`Отменить подарок ${cancelling?.number ?? ''}?`} label="Причина" confirm="Отменить подарок" danger testId="gift-cancel"
        text={<p>Подарок станет недействительным, запись о нём останется. Отменить можно только подарок без записи.</p>} onClose={() => setCancelling(null)}
        onConfirm={async (reason, k) => {
          await browserCall(`/gifts/${cancelling!.id}/cancel`, { method: 'POST', key: k, body: { reason } });
          setCancelling(null);
          setNotice('Подарок отменён.');
          await load();
        }} />
      <Modal open={booking !== null} title={`Записать подарок ${booking?.number ?? ''}`} onClose={() => setBooking(null)} wide testId="gift-book">
        <form class="yc-ev__stack" novalidate onSubmit={book}>
          <p>Клиент платит 0 ₽. В списке только будни без праздников в пределах срока – до {booking ? dayText(booking.validUntil) : ''}. Время – филиала.</p>
          {p.branches.length > 1 && (
            <label class="yc-field"><span class="yc-field__label">Филиал</span>
              <select class="yc-input" value={branchId} onChange={(e) => { setBranchId(e.currentTarget.value); if (booking) void offerDays(booking, e.currentTarget.value); }}>{p.branches.map((b) => <option value={b.id}>{b.name}</option>)}</select></label>
          )}
          <label class="yc-field"><span class="yc-field__label">День</span>
            <select class="yc-input" data-testid="gift-days" value={date} onChange={(e) => pickDay(e.currentTarget.value)}><option value="">Выберите день</option>{days.map((d) => <option value={d}>{dayText(d)}, {WEEKDAY[weekdayOf(d)]}</option>)}</select></label>
          {closedReason && <p class="yc-alert yc-alert--warn">{CLOSED[closedReason] ?? closedReason}</p>}
          {booking && slots && !closedReason && (slots.length === 0 ? <p class="yc-empty" data-testid="gift-no-slots">В этот день свободных окон нет: нужны комната и оба шлема сразу.</p> : (
            <div class="yc-ev__slots" role="group" aria-label="Время" data-testid="gift-slots">
              {slots.map((s) => <button key={s.start} type="button" class="yc-seg__btn yc-ev__slot" aria-pressed={slot === s.start} onClick={() => setSlot(s.start)}>{fmtHm(s.start, booking.timezone)}–{fmtHm(s.end, booking.timezone)}</button>)}
            </div>
          ))}
          <label class="yc-field"><span class="yc-field__label">Комментарий (необязательно)</span><input class="yc-input" type="text" maxLength={1000} value={comment} onInput={(e) => setComment(e.currentTarget.value)} /></label>
          {bookError && <p class="yc-alert yc-alert--error" role="alert">{bookError}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setBooking(null)}>Назад</button>
            <button class="yc-btn" type="submit" disabled={busy}>Записать</button>
          </div>
        </form>
      </Modal>
    </>
  );
  return p.mode === 'client'
    ? <section class="yc-panel" aria-labelledby="client-gifts" data-testid="client-gifts"><h2 id="client-gifts">Подарок имениннику</h2>{body}</section>
    : body;
}
