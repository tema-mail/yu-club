// Календарь филиала по ресурсам (S1-22, K11 №2): день – лента времени по строкам ресурсов, неделя (≤ 7 дней) –
// таблица «ресурс × день». Данные – GET /branches/{id}/calendar: брони, удержания сайта и блокировки тем же составом,
// что видит запись на сайте (availability), поэтому занятость в CRM и на сайте одна. Время – в зоне филиала.
// Широкая лента прокручивается внутри блока, страница на 390 px не едет. Режим pick – выбор слота для переноса.
// В режиме browse смена даты и вида – переход по адресу (?date=&view=): рабочий стол страницы считается на ту же дату.
// S2-64: у пришедших и завершённых – отметка оплаты первой строкой (короткая бронь обрезает хвост) (K10 №23 POST /bookings/payment-status): «к оплате» или «оплачено».
// Нет права на статусы оплаты или ошибка – календарь работает без отметки.
// S3-83: мероприятия видны занятостью (ссылка на карточку) и в режиме выбора слота; API календаря их не отдаёт – строки из /events и карточек (lib/events.ts).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { loadCalendarEvents, type CalendarEventItem } from '../lib/events.ts';
import {
  MAX_DAYS, STATUS_LABEL, addDays, bookingApi, bookingError, fmtDay, fmtRange, hmOf, inZone, isLocalDate, today as todayIn, zonedMs,
  type CalendarDto, type CalendarItem,
} from '../lib/booking.ts';

export type CalendarView = 'day' | 'week';
export interface SlotPick { resourceId: string; resourceName: string; date: string; hm: string }

export interface BranchCalendarProps {
  branchId: string;
  timezone: string;
  view: CalendarView;
  date: string;
  initial?: CalendarDto | null;
  /** browse – экран расписания (адрес страницы следует за датой и видом); pick – выбор слота. */
  mode?: 'browse' | 'pick';
  /** Пустой слот: создать бронь (browse, при праве booking.create) или выбрать время переноса (pick). */
  onSlot?: (slot: SlotPick) => void;
  /** Бронь, которую переносим: подсвечивается и не мешает выбрать её же место. */
  highlightId?: string;
  /** Перечитать данные (после создания брони). */
  reloadKey?: number;
}

type PayStatus = 'unpaid' | 'paid' | 'partially_refunded' | 'refunded';
type PayMap = ReadonlyMap<string, PayStatus>;
const PAY_IDS_MAX = 200; // K10 №23: bookingIds ≤ 200 за запрос
const ID_RE = /^[0-9a-f-]{36}$/i;
const visited = (i: CalendarItem) => i.kind === 'booking' && (i.booking!.status === 'arrived' || i.booking!.status === 'completed');
/** Отметка оплаты: только у пришедших и завершённых и только если статус известен. */
const payMark = (i: CalendarItem, pay: PayMap): string | null => {
  const st = visited(i) ? pay.get(i.id) : undefined;
  return st === undefined ? null : st === 'paid' || st === 'partially_refunded' ? 'оплачено' : 'к оплате';
};

async function loadPay(items: CalendarItem[]): Promise<Map<string, PayStatus>> {
  const ids = [...new Set(items.filter((i) => visited(i) && ID_RE.test(i.id)).map((i) => i.id))];
  const out = new Map<string, PayStatus>();
  for (let k = 0; k < ids.length; k += PAY_IDS_MAX) {
    const r = await browserCall<{ items: Array<{ bookingId: string; status: PayStatus }> }>('/bookings/payment-status', { method: 'POST', body: { bookingIds: ids.slice(k, k + PAY_IDS_MAX) } });
    for (const x of r.items) out.set(x.bookingId, x.status);
  }
  return out;
}

const PX_PER_MIN = 1.1; // час ≈ 66 px: плотно, но подпись брони читается
const SLOT_MIN = 30;
const DAY_MIN = 24 * 60;

const itemText = (i: CalendarItem) =>
  i.kind === 'booking' ? `№${i.booking!.number} ${i.booking!.clientName ?? 'Без имени'}` : i.kind === 'hold' ? 'Оформляется на сайте' : `Блокировка: ${i.block!.reasonName}`;
const itemClass = (i: CalendarItem, highlight?: string) => {
  if (i.kind !== 'booking') return `yc-cal__item yc-cal__item--${i.kind}`;
  const b = i.booking!;
  return `yc-cal__item yc-cal__item--${b.status}${b.needsDecision ? ' yc-cal__item--decide' : ''}${i.id === highlight ? ' yc-cal__item--current' : ''}`;
};
const itemLabel = (i: CalendarItem, tz: string, pay: PayMap) => {
  const time = fmtRange(i.start, i.end, tz);
  if (i.kind === 'booking') {
    const b = i.booking!;
    const mark = payMark(i, pay);
    return `Бронь №${b.number}, ${time}, ${b.clientName ?? 'без имени'} ${b.phoneMasked}, ${STATUS_LABEL[b.status]}${b.needsDecision ? ', требует решения' : ''}${mark ? `, ${mark}` : ''}`;
  }
  return `${itemText(i)}, ${time}`;
};

/** Минуты от начала дня date (зона филиала), обрезано по суткам. */
function minutesIn(at: string, date: string, tz: string): number {
  const z = inZone(at, tz);
  if (z.date < date) return 0;
  if (z.date > date) return DAY_MIN;
  return z.minutes;
}

/** Минута, с которой видна лента дня: открытие филиала; сейчас внутри часов работы – час до «сейчас», не раньше открытия. */
export function scrollTarget(open: ReadonlyArray<readonly [number, number]>, nowMin: number | null, fallback: number): number {
  const sorted = [...open].sort((a, b) => a[0] - b[0]);
  const cur = nowMin === null ? undefined : sorted.find(([s, e]) => nowMin >= s && nowMin < e);
  if (cur && nowMin !== null) return Math.max(cur[0], Math.floor(nowMin / 60) * 60 - 60);
  return sorted[0]?.[0] ?? fallback;
}

export default function BranchCalendar(props: BranchCalendarProps) {
  const { branchId, timezone: tz, mode = 'browse' } = props;
  const [view, setView] = useState<CalendarView>(props.view);
  const [date, setDate] = useState(props.date);
  const [data, setData] = useState<CalendarDto | null>(props.initial ?? null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!props.initial);
  const [skipFirst, setSkipFirst] = useState(!!props.initial);
  const [retry, setRetry] = useState(0);
  const [pay, setPay] = useState<PayMap>(new Map());
  const [events, setEvents] = useState<CalendarEventItem[]>([]);
  const [eventsError, setEventsError] = useState(false);

  const from = date;
  const to = view === 'week' ? addDays(date, MAX_DAYS - 1) : date;

  useEffect(() => {
    if (skipFirst) {
      setSkipFirst(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    bookingApi.calendar(branchId, from, to).then(
      (d) => alive && (setData(d), setLoading(false)),
      (e) => alive && (setError(bookingError(e)), setLoading(false)),
    );
    return () => {
      alive = false;
    };
  }, [branchId, from, to, retry, props.reloadKey]);

  useEffect(() => {
    if (!data || !data.items.some(visited)) return setPay(new Map());
    let alive = true;
    loadPay(data.items).then((m) => alive && setPay(m), () => alive && setPay(new Map()));
    return () => {
      alive = false;
    };
  }, [data]);

  useEffect(() => {
    if (!data || data.resources.length === 0) return setEvents([]);
    let alive = true;
    setEventsError(false);
    loadCalendarEvents(branchId, from, to, tz, data.resources.map((r) => r.id)).then(
      (x) => alive && setEvents(x),
      (e) => {
        if (!alive) return;
        setEvents([]);
        setEventsError(!(e instanceof ApiError && e.status === 403));
      },
    );
    return () => {
      alive = false;
    };
  }, [data]);

  /** browse – полный переход (рабочий стол на странице считается на ту же дату), pick – только календарь. */
  const show = (d: string, v: CalendarView) => {
    if (!isLocalDate(d)) return;
    if (mode === 'browse') {
      const u = new URL(location.href);
      u.searchParams.set('date', d);
      u.searchParams.set('view', v);
      location.assign(u);
      return;
    }
    setDate(d);
    setView(v);
  };
  const go = (d: string) => show(d, view);
  const step = view === 'week' ? MAX_DAYS : 1;
  const nowLocal = inZone(Date.now(), tz);

  return (
    <section class="yc-cal" aria-label="Календарь филиала" data-testid="calendar" aria-busy={loading}>
      <div class="yc-cal__bar">
        <div class="yc-seg" role="group" aria-label="Вид">
          <button type="button" class="yc-seg__btn" aria-pressed={view === 'day'} onClick={() => show(date, 'day')}>День</button>
          <button type="button" class="yc-seg__btn" aria-pressed={view === 'week'} onClick={() => show(date, 'week')}>Неделя</button>
        </div>
        <div class="yc-cal__nav">
          <button type="button" class="yc-btn yc-btn--ghost" aria-label={view === 'week' ? 'Предыдущая неделя' : 'Предыдущий день'} onClick={() => go(addDays(date, -step))}>‹</button>
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => go(todayIn(tz))}>Сегодня</button>
          <button type="button" class="yc-btn yc-btn--ghost" aria-label={view === 'week' ? 'Следующая неделя' : 'Следующий день'} onClick={() => go(addDays(date, step))}>›</button>
          <input class="yc-input yc-cal__date" type="date" aria-label="Дата" value={date} onChange={(e) => go((e.target as HTMLInputElement).value)} />
        </div>
      </div>
      <p class="yc-cal__title" data-testid="calendar-title">
        {view === 'day' ? fmtDay(date, 'long') : `${fmtDay(from)} – ${fmtDay(to)}`} · время филиала ({tz})
      </p>
      {error && (
        <p class="yc-alert yc-alert--error" role="alert">
          Календарь не загрузился: {error}{' '}
          <button type="button" class="yc-link" onClick={() => setRetry((n) => n + 1)}>Повторить</button>
        </p>
      )}
      {eventsError && <p class="yc-alert yc-alert--error" role="alert" data-testid="calendar-events-error">Мероприятия не загрузились: занятость комнат показана не вся. Обновите страницу.</p>}
      {data && data.resources.length === 0 && <p class="yc-empty">В филиале нет ресурсов для записи. Добавьте их в разделе «Ресурсы».</p>}
      {data && data.resources.length > 0 && (view === 'day'
        ? <DayGrid data={data} date={date} tz={tz} nowLocal={nowLocal} mode={mode} onSlot={props.onSlot} highlight={props.highlightId} pay={pay} events={events} />
        : <WeekGrid data={data} from={from} to={to} tz={tz} onDay={(d) => show(d, 'day')} highlight={props.highlightId} pay={pay} events={events} />)}
      <ul class="yc-cal__legend" aria-label="Обозначения">
        <li><i class="yc-cal__key yc-cal__item--confirmed" />подтверждена</li>
        <li><i class="yc-cal__key yc-cal__item--arrived" />пришёл</li>
        <li><i class="yc-cal__key yc-cal__item--decide" />требует решения</li>
        <li><strong>к оплате</strong>&nbsp;– пришёл, оплата не проведена</li>
        <li><i class="yc-cal__key yc-cal__item--hold" />оформляется на сайте</li>
        <li><i class="yc-cal__key yc-cal__item--block" />блокировка</li>
        <li><i class="yc-cal__key" style={EVENT_STYLE} />мероприятие</li>
      </ul>
    </section>
  );
}

interface DayProps {
  data: CalendarDto; date: string; tz: string; nowLocal: { date: string; minutes: number };
  mode: 'browse' | 'pick'; onSlot: BranchCalendarProps['onSlot']; highlight?: string; pay: PayMap; events: CalendarEventItem[];
}

const EVENT_STYLE = { background: 'var(--yc-accent-bg)', color: 'var(--yc-accent)', borderColor: 'var(--yc-accent)' };

function DayGrid({ data, date, tz, nowLocal, mode, onSlot, highlight, pay, events }: DayProps) {
  // Видимый отрезок: часы работы дня, расширенные до броней вне часов; по умолчанию 10–22.
  const range = useMemo(() => {
    const spans = [...data.openIntervals, ...data.items].map((x) => [minutesIn(x.start, date, tz), minutesIn(x.end, date, tz)] as const).filter(([s, e]) => e > s);
    const s = spans.length ? Math.min(...spans.map((x) => x[0])) : 600;
    const e = spans.length ? Math.max(...spans.map((x) => x[1])) : 1320;
    return { start: Math.floor(s / 60) * 60, end: Math.min(DAY_MIN, Math.ceil(e / 60) * 60) };
  }, [data, date, tz]);
  const width = (range.end - range.start) * PX_PER_MIN;
  const x = (m: number) => (Math.max(range.start, Math.min(range.end, m)) - range.start) * PX_PER_MIN;
  const hours: number[] = [];
  for (let m = range.start; m < range.end; m += 60) hours.push(m);
  const open = data.openIntervals.map((i) => [minutesIn(i.start, date, tz), minutesIn(i.end, date, tz)] as const);
  const closed: Array<[number, number]> = [];
  let cursor = range.start;
  for (const [s, e] of [...open].sort((a, b) => a[0] - b[0])) {
    if (s > cursor) closed.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < range.end) closed.push([cursor, range.end]);
  const slots: number[] = [];
  for (let m = range.start; m < range.end; m += SLOT_MIN) slots.push(m);
  const nowMs = Date.now();
  const isToday = nowLocal.date === date;
  const canPick = !!onSlot;
  // Лента открывается на открытии филиала, а если филиал сейчас работает – на часе до «сейчас» (не раньше открытия).
  // Короткий хвост ленты не дал бы докрутить до открытия – добавляем справа пустое поле (pad) под нужную прокрутку.
  const scroller = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const want = Math.max(0, x(scrollTarget(open, isToday ? nowLocal.minutes : null, range.start)));
    const lack = Math.ceil(want - (el.scrollWidth - el.clientWidth));
    if (lack > 0) setPad((p) => p + lack);
    else el.scrollLeft = want;
  }, [date, range.start, pad]);

  return (
    <div class="yc-cal__scroll" ref={scroller} tabIndex={0} aria-label="Лента дня, прокручивается по горизонтали" data-testid="calendar-scroll">
      <div class="yc-cal__day" style={{ '--yc-cal-w': `${width + pad}px` }}>
        <div class="yc-cal__corner">Ресурс</div>
        <div class="yc-cal__hours" aria-hidden="true">
          {hours.map((m) => <span style={{ left: `${x(m)}px` }}>{hmOf(m)}</span>)}
        </div>
        {data.resources.map((r) => {
          const items = data.items.filter((i) => i.resourceIds.includes(r.id) && minutesIn(i.end, date, tz) > minutesIn(i.start, date, tz));
          return (
            <>
              <div class="yc-cal__res" data-testid={`cal-res-${r.id}`}>
                <span class="yc-cal__res-name">{r.name}</span>
                {r.roomName && <span class="yc-cal__res-room">{r.roomName}</span>}
              </div>
              <div class="yc-cal__lane" data-testid={`cal-lane-${r.id}`}>
                {closed.map(([s, e]) => <span class="yc-cal__closed" style={{ left: `${x(s)}px`, width: `${x(e) - x(s)}px` }} aria-hidden="true" />)}
                {pad > 0 && <span class="yc-cal__closed" style={{ left: `${width}px`, width: `${pad}px` }} aria-hidden="true" />}
                {hours.map((m) => <span class="yc-cal__tick" style={{ left: `${x(m)}px` }} aria-hidden="true" />)}
                {canPick && slots.map((m) => {
                  const past = zonedMs(date, hmOf(m), tz) <= nowMs;
                  const inOpen = open.some(([s, e]) => m >= s && m < e);
                  if (past || !inOpen) return null;
                  return (
                    <button type="button" class="yc-cal__slot" style={{ left: `${x(m)}px`, width: `${SLOT_MIN * PX_PER_MIN}px` }}
                      aria-label={`${r.name}, ${hmOf(m)} – ${mode === 'pick' ? 'перенести сюда' : 'новая запись'}`}
                      onClick={() => onSlot!({ resourceId: r.id, resourceName: r.name, date, hm: hmOf(m) })} />
                  );
                })}
                {items.map((i) => {
                  const s = minutesIn(i.start, date, tz);
                  const e = minutesIn(i.end, date, tz);
                  const style = { left: `${x(s)}px`, width: `${Math.max(x(e) - x(s), 6)}px` };
                  const mark = payMark(i, pay);
                  const body = (
                    <>
                      <span class="yc-cal__item-time">{mark && <><strong data-testid="cal-pay">{mark}</strong> · </>}{fmtRange(i.start, i.end, tz, false)}</span>
                      <span class="yc-cal__item-text">{itemText(i)}</span>
                    </>
                  );
                  return i.kind === 'booking' && mode === 'browse'
                    ? <a class={itemClass(i, highlight)} style={style} href={`/bookings/${encodeURIComponent(i.id)}`} aria-label={itemLabel(i, tz, pay)} data-testid="cal-item">{body}</a>
                    : <span class={itemClass(i, highlight)} style={style} role="img" aria-label={itemLabel(i, tz, pay)} data-testid="cal-item">{body}</span>;
                })}
                {events.filter((ev) => ev.resourceIds.includes(r.id) && minutesIn(ev.end, date, tz) > minutesIn(ev.start, date, tz)).map((ev) => {
                  const s = minutesIn(ev.start, date, tz);
                  const e = minutesIn(ev.end, date, tz);
                  return (
                    <a class="yc-cal__item" style={{ ...EVENT_STYLE, left: `${x(s)}px`, width: `${Math.max(x(e) - x(s), 6)}px` }} href={`/events/${ev.id}`} aria-label={`Мероприятие ${ev.number}, ${fmtRange(ev.start, ev.end, tz)}, ${ev.title}`} data-testid="cal-event">
                      <span class="yc-cal__item-time">{fmtRange(ev.start, ev.end, tz, false)}</span>
                      <span class="yc-cal__item-text">{ev.number} {ev.title}</span>
                    </a>
                  );
                })}
                {isToday && nowLocal.minutes >= range.start && nowLocal.minutes <= range.end && (
                  <span class="yc-cal__now" style={{ left: `${x(nowLocal.minutes)}px` }} aria-hidden="true" />
                )}
              </div>
            </>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({ data, from, to, tz, onDay, highlight, pay, events }: { data: CalendarDto; from: string; to: string; tz: string; onDay: (d: string) => void; highlight?: string; pay: PayMap; events: CalendarEventItem[] }) {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const hoursOf = (d: string) => {
    const i = data.openIntervals.filter((x) => inZone(x.start, tz).date === d);
    return i.length ? i.map((x) => fmtRange(x.start, x.end, tz, false)).join(', ') : 'закрыто';
  };
  return (
    <div class="yc-cal__scroll" tabIndex={0} aria-label="Неделя, прокручивается по горизонтали" data-testid="calendar-scroll">
      <table class="yc-cal__week">
        <thead>
          <tr>
            <th scope="col" class="yc-cal__corner">Ресурс</th>
            {days.map((d) => (
              <th scope="col">
                <button type="button" class="yc-link yc-cal__daylink" onClick={() => onDay(d)}>{fmtDay(d)}</button>
                <span class="yc-cal__dayhours">{hoursOf(d)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.resources.map((r) => (
            <tr>
              <th scope="row" class="yc-cal__res">
                <span class="yc-cal__res-name">{r.name}</span>
                {r.roomName && <span class="yc-cal__res-room">{r.roomName}</span>}
              </th>
              {days.map((d) => {
                const items = data.items.filter((i) => i.resourceIds.includes(r.id) && minutesIn(i.end, d, tz) > minutesIn(i.start, d, tz));
                const evs = events.filter((ev) => ev.resourceIds.includes(r.id) && minutesIn(ev.end, d, tz) > minutesIn(ev.start, d, tz));
                return (
                  <td data-testid={`week-${r.id}-${d}`}>
                    {items.length === 0 && evs.length === 0 ? <span class="yc-cal__free">свободно</span> : (
                      <ul class="yc-cal__chips">
                        {evs.map((ev) => (
                          <li>
                            <a class="yc-cal__item" style={EVENT_STYLE} href={`/events/${ev.id}`} aria-label={`Мероприятие ${ev.number}, ${fmtRange(ev.start, ev.end, tz)}, ${ev.title}`} data-testid="cal-event">
                              <span class="yc-cal__item-time">{fmtRange(ev.start, ev.end, tz, false)}</span> <span class="yc-cal__item-text">{ev.number} {ev.title}</span>
                            </a>
                          </li>
                        ))}
                        {items.map((i) => (
                          <li>
                            {i.kind === 'booking'
                              ? <a class={itemClass(i, highlight)} href={`/bookings/${encodeURIComponent(i.id)}`} aria-label={itemLabel(i, tz, pay)} data-testid="cal-item">
                                  <span class="yc-cal__item-time">{payMark(i, pay) && <><strong data-testid="cal-pay">{payMark(i, pay)}</strong> · </>}{fmtRange(i.start, i.end, tz, false)}</span> <span class="yc-cal__item-text">{itemText(i)}</span>
                                </a>
                              : <span class={itemClass(i, highlight)} role="img" aria-label={itemLabel(i, tz, pay)} data-testid="cal-item">
                                  <span class="yc-cal__item-time">{fmtRange(i.start, i.end, tz, false)}</span> <span class="yc-cal__item-text">{itemText(i)}</span>
                                </span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
