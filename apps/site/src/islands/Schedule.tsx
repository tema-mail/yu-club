// Остров расписания (S1-19, карта сайта: /schedule/): сетка дня по ресурсам и их шагу (VR 15 мин, ПК и PS 30), фильтр зоны,
// дни окна записи (по умолчанию defaultDays, «ещё» – до maxDays, K7), 6 состояний слота из GET availability (K5 №5).
// Клик по свободному слоту – удержание (POST /holds или /holds/{id}/items: сервер перезапускает общий таймер), по своему –
// снять позицию. Таймер – HoldTimer от серверного expiresAt. Истёк – фраза и сброс выбора; ошибка выбор не сбрасывает.
// Состояние слота видно не только цветом: знак в ячейке, подпись в легенде и aria-label у кнопки.
// «Оформить запись» – шаг Checkout (S1-20) на месте сетки; таймер идёт и там, истечение возвращает к выбору.
// Э2 (S2-72): вошедший клиент с балансом −50 видит текст 07 §9.2 до выбора слота, слоты недоступны. Резерв баллов
// (выбор в Checkout) живёт здесь: сменился состав удержания – резерв снят сервером (K15 §3), говорим об этом фразой.
// Э3 (S3-92, K20 §10): режим подарка имениннику – /schedule/?gift={id} из ЛК (id держится в sessionStorage вкладки, пока клиент
// выбирает клуб). Дни – только будни из условий подарка в пределах срока и окна записи; праздник и прочее закрытие дня говорит сервер
// (П1 /me/gifts/{id}/slots, closedReason). Окна – только те, где свободны оба шлема на всё время подарка. Клик – П2 /me/gifts/{id}/hold:
// обычное удержание K5 с тем же таймером, дальше обычное оформление с ценой 0 (Checkout gift).
import { useEffect, useRef, useState } from 'preact/hooks';
import { API_PREFIX, ZONE_LABEL, ZONE_ORDER, type ZoneCode } from '../lib/api.ts';
import {
  LIMIT_TEXT, UI_STATES, addDays, bookingApi, loyaltyApi, dayLabel, describeError, holdDeadline, holdStoreKey, rub, timeIn,
  type AvailabilityDto, type HoldDto, type SlotDto, type SlotState, type UiState,
} from '../lib/booking.ts';
import { ClientApiError } from '../lib/client.ts';
import Checkout, { RESERVE_DROPPED, holdSignature, type PointsReserve } from './Checkout.tsx';
import HoldTimer from './HoldTimer.tsx';
import { GIFT_STORE_KEY, fmtDay, giftApi, type MyGiftDto } from './MyGift.tsx';

// ── Подарок имениннику (П1, П2 – apps/api/src/modules/events/routes.gifts.ts) ──
interface GiftSlotsDto { date: string; closedReason: string | null; slots: Array<{ start: string; end: string }> }
type GiftMode = { kind: 'off' } | { kind: 'gone' } | { kind: 'loading' | 'auth' | 'error'; id: string } | { kind: 'on'; gift: MyGiftDto };
/** Почему день закрыт для подарка – фраза посетителю. */
const GIFT_CLOSED: Record<string, string> = {
  GIFT_WEEKDAY_ONLY: 'Подарком можно воспользоваться с понедельника по пятницу. Выберите будний день.',
  GIFT_HOLIDAY: 'Это праздничный день – в праздники подарок не действует. Выберите другой день.',
  GIFT_EXPIRED: 'Этот день позже срока подарка. Выберите день раньше.',
  GIFT_NOT_ACTIVE: 'Подарок уже не действует или по нему уже есть запись – она в личном кабинете.',
  GIFT_ALREADY_RESERVED: 'По подарку уже есть запись – она в личном кабинете.',
  GIFT_COMPOSITION_INVALID: 'В подарок входят только 2 шлема Meta Quest 3S. Обновите страницу и выберите время заново.',
  OUTSIDE_BOOKING_WINDOW: 'Этот день ещё не открыт для записи или уже прошёл.',
  RESOURCE_UNAVAILABLE: 'В этом клубе запись по подарку недоступна. Выберите другой клуб.',
};
const weekdayOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7;

async function giftCall<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method === 'POST') Object.assign(headers, { 'content-type': 'application/json', 'x-requested-with': 'yu-site', 'idempotency-key': crypto.randomUUID() });
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, { method, headers, credentials: 'same-origin', body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  } catch {
    throw new ClientApiError(0, 'NETWORK', '');
  }
  if (!res.ok) {
    let b: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
    try {
      b = (await res.json()) as typeof b;
    } catch {
      // тело не JSON – общий код ниже
    }
    throw new ClientApiError(res.status, b.error?.code ?? 'INTERNAL', b.error?.message ?? '', b.error?.details ?? {});
  }
  return (await res.json()) as T;
}
const enc = encodeURIComponent;
const giftSlotsOf = (id: string, branchId: string, date: string) => giftCall<GiftSlotsDto>('GET', `/me/gifts/${enc(id)}/slots/?branchId=${enc(branchId)}&date=${enc(date)}`);
const giftHoldOf = (id: string, branchId: string, start: string) => giftCall<HoldDto>('POST', `/me/gifts/${enc(id)}/hold/`, { branchId, start });

export interface ScheduleBranch {
  id: string; name: string; timezone: string;
  bookingWindow: { defaultDays: number; maxDays: number };
}
export interface ScheduleResource { id: string; name: string; zone: ZoneCode; stepMinutes: number; roomName: string | null; roomId: string | null }

interface Props {
  branch: ScheduleBranch;
  resources: ScheduleResource[];
  /** Сегодня по зоне филиала – с сервера страницы. */
  today: string;
  zone: ZoneCode | null;
  /** Предвыбор комнаты со страницы комнаты (S1-21): в сетке – только её места, каждое отдельно (12 §7.2). */
  room: { id: string; name: string } | null;
}

const STATE_WORD: Record<SlotState, string> = {
  free: 'свободно', mine: 'выбрано вами', held: 'удерживается другим гостем', booked: 'занято', blocked: 'на обслуживании', closed: 'вне графика',
};
const LEGEND: SlotState[] = ['free', 'mine', 'held', 'booked', 'blocked', 'closed'];
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

type Notice = { state: UiState; text: string };

export default function Schedule({ branch, resources, today, zone: initialZone, room: initialRoom }: Props) {
  const tz = branch.timezone;
  const [date, setDate] = useState(today);
  const [zone, setZone] = useState<ZoneCode | null>(initialZone);
  const [room, setRoom] = useState(initialRoom);
  const [allDays, setAllDays] = useState(false);
  const [avail, setAvail] = useState<AvailabilityDto | null>(null);
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [hold, setHold] = useState<HoldDto | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [phase, setPhase] = useState<'held' | 'expiring'>('held');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'pick' | 'checkout'>('pick');
  const holdRef = useRef<HoldDto | null>(null);
  const [limited, setLimited] = useState(false);
  const [reserve, setReserve] = useState<PointsReserve | null>(null);
  const reserveRef = useRef<PointsReserve | null>(null);
  const checkoutTitle = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  const reqNo = useRef(0);
  const [giftMode, setGiftMode] = useState<GiftMode>({ kind: 'off' });
  const [giftSlots, setGiftSlots] = useState<GiftSlotsDto | 'loading' | 'error'>('loading');
  const giftReq = useRef(0);
  const gift = giftMode.kind === 'on' ? giftMode.gift : null;
  /** Дни подарка: будни условий в пределах срока и окна записи филиала. */
  const giftDays = gift
    ? Array.from({ length: branch.bookingWindow.maxDays }, (_, i) => addDays(today, i)).filter((d) => d <= gift.validUntil && gift.terms.weekdays.includes(weekdayOf(d)))
    : [];

  function keepReserve(r: PointsReserve | null) {
    reserveRef.current = r;
    setReserve(r);
  }

  function adopt(h: HoldDto | null) {
    const live = h && h.status === 'active' && h.items.length > 0 ? h : null;
    const r = reserveRef.current;
    if (r && (!live || holdSignature(live) !== r.signature)) {
      keepReserve(null);
      if (live) setNotice({ state: 'held', text: RESERVE_DROPPED });
    }
    holdRef.current = live;
    setHold(live);
    setDeadline(live ? holdDeadline(live) : null);
    setPhase('held');
    if (!live) setStep('pick');
    if (live) sessionStorage.setItem(holdStoreKey(branch.id), live.id);
    else sessionStorage.removeItem(holdStoreKey(branch.id));
  }

  // −50 (07 §9.2): проверка при открытии – чтобы объяснить до выбора слота; без входа (401) ограничения нет.
  useEffect(() => {
    loyaltyApi.balance().then((b) => setLimited(b.preBookingBlocked)).catch(() => undefined);
  }, []);

  // Удержание переживает перезагрузку: восстанавливаем по id, срок – серверный.
  useEffect(() => {
    const id = sessionStorage.getItem(holdStoreKey(branch.id));
    if (!id) return;
    bookingApi.getHold(id).then(adopt).catch(() => adopt(null));
  }, []);

  useEffect(() => {
    const n = ++reqNo.current;
    setLoad('loading');
    bookingApi
      .availability(branch.id, date)
      .then((a) => {
        if (n !== reqNo.current) return;
        setAvail(a);
        setLoad('ok');
      })
      .catch(() => {
        if (n === reqNo.current) setLoad('error');
      });
  }, [date, reload]);

  const refresh = () => setReload((x) => x + 1);

  // Режим подарка: ?gift= из ЛК или id, сохранённый во вкладке, пока выбирали клуб. Подарок – только свой и действующий (П1).
  async function loadGift(id: string) {
    setGiftMode({ kind: 'loading', id });
    try {
      const g = (await giftApi.list()).items.find((x) => x.id === id);
      if (!g || (g.status !== 'issued' && g.status !== 'reserved')) {
        sessionStorage.removeItem(GIFT_STORE_KEY);
        setGiftMode({ kind: 'gone' });
        return;
      }
      setGiftMode({ kind: 'on', gift: g });
      const days = Array.from({ length: branch.bookingWindow.maxDays }, (_, i) => addDays(today, i)).filter((d) => d <= g.validUntil && g.terms.weekdays.includes(weekdayOf(d)));
      if (days[0]) setDate(days[0]);
    } catch (e) {
      setGiftMode(e instanceof ClientApiError && e.status === 401 ? { kind: 'auth', id } : { kind: 'error', id });
    }
  }
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('gift') ?? sessionStorage.getItem(GIFT_STORE_KEY);
    if (!id) return;
    sessionStorage.setItem(GIFT_STORE_KEY, id);
    void loadGift(id);
  }, []);

  useEffect(() => {
    if (!gift) return;
    const n = ++giftReq.current;
    setGiftSlots('loading');
    giftSlotsOf(gift.id, branch.id, date)
      .then((s) => n === giftReq.current && setGiftSlots(s))
      .catch(() => n === giftReq.current && setGiftSlots('error'));
  }, [gift?.id, date, reload]);

  function exitGift() {
    sessionStorage.removeItem(GIFT_STORE_KEY);
    const url = new URL(location.href);
    url.searchParams.delete('gift');
    history.replaceState(null, '', url.pathname + url.search);
    setGiftMode({ kind: 'off' });
    setNotice(null);
    setDate(today);
  }

  async function pickGift(start: string) {
    if (!gift || busy || holdRef.current) return;
    setBusy(true);
    setNotice(null);
    try {
      adopt(await giftHoldOf(gift.id, branch.id, start));
    } catch (e) {
      const code = e instanceof ClientApiError ? e.code : '';
      setNotice(GIFT_CLOSED[code] ? { state: 'conflict', text: GIFT_CLOSED[code] } : describeError(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  // Смена шага меняет высоту страницы: без этого браузер оставляет прежнюю прокрутку, шапка (sticky) встаёт
  // поверх середины страницы, а заголовок шага уезжает вверх. Каждый шаг начинается с верха страницы.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (step === 'checkout') checkoutTitle.current?.focus({ preventScroll: true });
  }, [step]);

  async function toggle(r: ScheduleResource, s: SlotDto) {
    if (busy || (s.state !== 'free' && s.state !== 'mine')) return;
    setBusy(true);
    setNotice(null);
    const input = { resourceId: r.id, start: s.start, end: s.end };
    const current = holdRef.current;
    try {
      if (s.state === 'mine') {
        const item = current?.items.find((i) => i.resourceId === r.id && Date.parse(i.start) === Date.parse(s.start));
        if (current && item) adopt(await bookingApi.removeItem(current.id, item.id));
      } else if (current) {
        adopt(await bookingApi.addItem(current.id, input));
      } else {
        try {
          adopt(await bookingApi.createHold(branch.id, input));
        } catch (e) {
          // Удержание уже есть (другая вкладка, перезагрузка без памяти) – берём его и добавляем слот туда.
          const existing = e instanceof ClientApiError && e.code === 'HOLD_ALREADY_ACTIVE' ? String(e.details.holdId ?? '') : '';
          if (!existing) throw e;
          adopt(await bookingApi.addItem(existing, input));
        }
      }
    } catch (e) {
      const d = describeError(e);
      if (d.state === 'expired') adopt(null);
      setNotice(d);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  function expire() {
    const h = holdRef.current;
    adopt(null);
    setNotice({ state: 'expired', text: UI_STATES.expired });
    // Сервер гасит истёкшее сам; release – чтобы слоты освободились сразу и при расхождении в доли секунды.
    if (h) bookingApi.release(h.id).catch(() => undefined).finally(refresh);
    else refresh();
  }

  async function cancel() {
    const h = holdRef.current;
    if (!h || busy) return;
    setBusy(true);
    try {
      await bookingApi.release(h.id);
      adopt(null);
      setNotice({ state: 'cancelled', text: UI_STATES.cancelled });
    } catch (e) {
      setNotice(describeError(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  // ── Что показать ─────────────────────────────────────────
  const zones = ZONE_ORDER.filter((z) => resources.some((r) => r.zone === z));
  const shown = resources.filter((r) => (!zone || r.zone === zone) && (!room || r.roomId === room.id));
  const rows = shown.map((r) => ({ r, slots: avail?.resources.find((x) => x.resourceId === r.id)?.slots ?? [] }));
  const all = rows.flatMap((x) => x.slots);
  const hasFree = avail?.dayState === 'open' && all.some((s) => s.state === 'free' || s.state === 'mine');
  const unit = shown.reduce((g, r) => gcd(g, r.stepMinutes), 0) || 30;
  const t0 = all.length ? Math.min(...all.map((s) => Date.parse(s.start))) : 0;
  const t1 = all.length ? Math.max(...all.map((s) => Date.parse(s.end))) : 0;
  const cols = Math.max(1, Math.round((t1 - t0) / (unit * 60_000)));
  const col = (iso: string) => Math.round((Date.parse(iso) - t0) / (unit * 60_000)) + 2;
  const hours: string[] = [];
  for (let t = t0; t < t1; t += 3600_000) hours.push(new Date(t).toISOString());

  const status: Notice = notice
    ?? (load === 'loading' ? { state: 'loading', text: UI_STATES.loading }
      : load === 'error' ? { state: 'load_error', text: UI_STATES.load_error }
        : hold ? { state: phase, text: UI_STATES[phase] }
          : hasFree ? { state: 'loaded', text: UI_STATES.loaded }
            : { state: 'empty', text: UI_STATES.empty });

  const days = Array.from({ length: allDays ? branch.bookingWindow.maxDays : branch.bookingWindow.defaultDays }, (_, i) => addDays(today, i));

  const statusLine = (
    <div class="yu-sched__status" data-state={status.state} data-testid="schedule-status" role="status" aria-live="polite">
      <span>{status.text}</span>
      {status.state === 'load_error' && step === 'pick' && (
        <button type="button" class="yu-btn yu-btn--ghost yu-btn--small" onClick={() => { setNotice(null); refresh(); }}>Повторить</button>
      )}
    </div>
  );

  const holdPanel = hold && deadline !== null && (
    <section class="yu-hold" aria-labelledby="hold-title" data-testid="hold-panel">
      <h2 id="hold-title" class="yu-hold__title">{gift ? 'Запись по подарку' : 'Ваш выбор'}</h2>
      <HoldTimer deadline={deadline} onPhase={setPhase} onExpire={expire} />
      <ul class="yu-hold__items">
        {hold.items.map((i) => (
          <li key={i.id} class="yu-hold__item">
            <span>{i.resourceName}, {dayLabel(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(i.start))).day}, {timeIn(i.start, tz)}–{timeIn(i.end, tz)}</span>
            <span class="yu-hold__price">{rub(i.priceKop)}</span>
          </li>
        ))}
      </ul>
      <p class="yu-hold__total">Итого: <strong data-testid="hold-total">{rub(hold.totalKop)}</strong></p>
      <div class="yu-hold__actions">
        <button type="button" class="yu-btn" onClick={() => { setNotice(null); setStep('checkout'); }} disabled={busy}>Оформить запись</button>
        <button type="button" class="yu-btn yu-btn--ghost" onClick={cancel} disabled={busy}>Отменить выбор</button>
      </div>
    </section>
  );

  // ── Режим подарка: вместо сетки – будни срока и окна на оба шлема ──
  if (step === 'pick' && giftMode.kind !== 'off' && giftMode.kind !== 'gone') {
    const g = gift;
    const giftStatus: Notice = notice
      ?? (giftMode.kind === 'loading' ? { state: 'loading', text: 'Загружаем подарок…' }
        : giftMode.kind === 'auth' ? { state: 'forbidden', text: 'Чтобы записаться по подарку, войдите в личный кабинет.' }
          : giftMode.kind === 'error' || giftSlots === 'error' ? { state: 'load_error', text: 'Не удалось загрузить подарок. Проверьте связь и обновите страницу.' }
            : hold ? { state: phase, text: UI_STATES[phase] }
              : giftSlots === 'loading' ? { state: 'loading', text: UI_STATES.loading }
                : giftSlots.closedReason ? { state: 'empty', text: GIFT_CLOSED[giftSlots.closedReason] ?? UI_STATES.empty }
                  : giftSlots.slots.length === 0 ? { state: 'empty', text: `На этот день нет окна, где оба шлема свободны ${g?.terms.roomMinutes ?? 40} минут подряд. Выберите другой день.` }
                    : { state: 'loaded', text: `Выберите время начала: ${g?.terms.devices ?? 2} шлема ${g?.terms.device ?? ''} на ${g?.terms.roomMinutes ?? 40} минут.` });
    const windows = g && giftSlots !== 'loading' && giftSlots !== 'error' && !giftSlots.closedReason ? giftSlots.slots : [];
    return (
      <div class="yu-sched" data-testid="schedule">
        <div class="yu-notice yu-sched__status" data-testid="gift-mode">
          <span>
            {g
              ? `Запись по подарку имениннику № ${g.number}: ${g.terms.devices} × ${g.terms.device} на ${g.terms.roomMinutes} минут, с понедельника по пятницу, кроме праздников, до ${fmtDay(g.validUntil)} включительно. Бесплатно.`
              : 'Запись по подарку имениннику.'}
          </span>
          <button type="button" class="yu-btn yu-btn--ghost yu-btn--small" onClick={exitGift}>Обычная запись</button>
        </div>
        {giftMode.kind === 'auth' && (
          <a class="yu-btn" href={`/login/?next=${enc(`/schedule/?gift=${giftMode.id}`)}`}>Войти</a>
        )}
        {g && (
          <div class="yu-sched__days" role="group" aria-label="День">
            {giftDays.map((d) => {
              const l = dayLabel(d);
              return (
                <button type="button" key={d} class="yu-sched__day" aria-pressed={d === date} onClick={() => { setNotice(null); setDate(d); }} data-date={d}>
                  <span class="yu-sched__day-week">{d === today ? 'Сегодня' : d === addDays(today, 1) ? 'Завтра' : l.week}</span>
                  <span class="yu-sched__day-num">{l.day}</span>
                </button>
              );
            })}
          </div>
        )}
        <div class="yu-sched__status" data-state={giftStatus.state} data-testid="schedule-status" role="status" aria-live="polite">
          <span>{giftStatus.text}</span>
        </div>
        {windows.length > 0 && (
          <div class="yu-sched__zones" role="group" aria-label="Время начала" data-testid="gift-windows">
            {windows.map((w) => (
              <button
                type="button" key={w.start} class="yu-sched__zone" disabled={busy || hold !== null}
                aria-label={`Подарок, ${timeIn(w.start, tz)}–${timeIn(w.end, tz)}`} onClick={() => pickGift(w.start)}
              >
                {timeIn(w.start, tz)}–{timeIn(w.end, tz)}
              </button>
            ))}
          </div>
        )}
        {holdPanel}
      </div>
    );
  }

  if (step === 'checkout' && hold && deadline !== null) {
    return (
      <div class="yu-sched" data-testid="schedule">
        {limited && <p class="yu-notice" role="alert" data-testid="loyalty-limit-banner">{LIMIT_TEXT}</p>}
      {statusLine}
        <section class="yu-checkout" aria-labelledby="checkout-title">
          <h2 id="checkout-title" class="yu-hold__title" ref={checkoutTitle} tabIndex={-1}>Оформление записи</h2>
          <HoldTimer deadline={deadline} onPhase={setPhase} onExpire={expire} />
          <Checkout
            hold={hold} timezone={tz} onHold={adopt} onNotice={setNotice} reserve={reserve} onReserve={keepReserve} gift={gift !== null}
            onBack={() => { setStep('pick'); refresh(); }}
          />
        </section>
      </div>
    );
  }

  return (
    <div class="yu-sched" data-testid="schedule">
      <div class="yu-sched__controls">
        <div class="yu-sched__days" role="group" aria-label="День">
          {days.map((d, i) => {
            const l = dayLabel(d);
            return (
              <button type="button" key={d} class="yu-sched__day" aria-pressed={d === date} onClick={() => setDate(d)} data-date={d}>
                <span class="yu-sched__day-week">{i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : l.week}</span>
                <span class="yu-sched__day-num">{l.day}</span>
              </button>
            );
          })}
          {!allDays && branch.bookingWindow.maxDays > branch.bookingWindow.defaultDays && (
            <button type="button" class="yu-sched__day yu-sched__day--more" onClick={() => setAllDays(true)}>
              Ещё дни – до {branch.bookingWindow.maxDays}
            </button>
          )}
        </div>
        {(zones.length > 1 || room) && (
          <div class="yu-sched__zones" role="group" aria-label="Зона">
            <button type="button" class="yu-sched__zone" aria-pressed={zone === null && !room} onClick={() => { setRoom(null); setZone(null); }}>Все зоны</button>
            {zones.map((z) => (
              <button type="button" key={z} class="yu-sched__zone" aria-pressed={zone === z && !room} onClick={() => { setRoom(null); setZone(z); }}>{ZONE_LABEL[z]}</button>
            ))}
            {room && <button type="button" class="yu-sched__zone" aria-pressed="true" data-testid="room-filter">{room.name}</button>}
          </div>
        )}
      </div>

      {limited && <p class="yu-notice" role="alert" data-testid="loyalty-limit-banner">{LIMIT_TEXT}</p>}
      {giftMode.kind === 'gone' && (
        <p class="yu-notice" role="status" data-testid="gift-gone">Подарок уже использован, истёк или по нему есть запись. Ниже – обычная запись.</p>
      )}
      {statusLine}

      {avail?.dayState === 'open' && all.length > 0 && (
        <div class="yu-sched__scroll" tabIndex={0} aria-label="Сетка расписания, листается вбок">
          <div class="yu-sched__grid" style={{ '--cols': cols }} aria-busy={busy || load === 'loading'}>
            <div class="yu-sched__row yu-sched__row--head" aria-hidden="true">
              <span class="yu-sched__label" />
              {hours.map((h) => (
                <span class="yu-sched__hour" key={h} style={{ gridColumn: `${col(h)} / span ${Math.min(60 / unit, cols - col(h) + 2)}` }}>{timeIn(h, tz)}</span>
              ))}
            </div>
            {rows.map(({ r, slots }) => (
              <div class="yu-sched__row" key={r.id}>
                <span class="yu-sched__label">
                  <span class="yu-sched__res">{r.name}</span>
                  {r.roomName && r.roomName !== r.name && <span class="yu-sched__room">{r.roomName}</span>}
                </span>
                {slots.map((s) => {
                  const label = `${r.name}, ${timeIn(s.start, tz)}–${timeIn(s.end, tz)}, ${STATE_WORD[s.state]}`;
                  const active = s.state === 'mine' || (s.state === 'free' && !limited);
                  return (
                    <button
                      type="button" key={s.start} class={`yu-slot yu-slot--${s.state}`} data-state={s.state}
                      style={{ gridColumn: `${col(s.start)} / span ${Math.round((Date.parse(s.end) - Date.parse(s.start)) / (unit * 60_000))}` }}
                      aria-label={label} title={label} aria-pressed={s.state === 'mine' ? true : undefined}
                      disabled={!active} onClick={() => toggle(r, s)}
                    >
                      {timeIn(s.start, tz)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <ul class="yu-legend" aria-label="Обозначения">
        {LEGEND.map((s) => (
          <li key={s}><span class={`yu-slot yu-slot--${s} yu-legend__mark`} aria-hidden="true" />{STATE_WORD[s]}</li>
        ))}
      </ul>

      {holdPanel}
    </div>
  );
}
