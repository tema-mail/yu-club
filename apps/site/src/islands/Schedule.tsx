// Остров расписания (S1-19, карта сайта: /schedule/): сетка дня по ресурсам и их шагу (VR 15 мин, ПК и PS 30), фильтр зоны,
// дни окна записи (по умолчанию defaultDays, «ещё» – до maxDays, K7), 6 состояний слота из GET availability (K5 №5).
// Клик по свободному слоту – удержание (POST /holds или /holds/{id}/items: сервер перезапускает общий таймер), по своему –
// снять позицию. Таймер – HoldTimer от серверного expiresAt. Истёк – фраза и сброс выбора; ошибка выбор не сбрасывает.
// Состояние слота видно не только цветом: знак в ячейке, подпись в легенде и aria-label у кнопки.
// «Оформить запись» – шаг Checkout (S1-20) на месте сетки; таймер идёт и там, истечение возвращает к выбору.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ZONE_LABEL, ZONE_ORDER, type ZoneCode } from '../lib/api.ts';
import {
  UI_STATES, addDays, bookingApi, dayLabel, describeError, holdDeadline, holdStoreKey, rub, timeIn,
  type AvailabilityDto, type HoldDto, type SlotDto, type SlotState, type UiState,
} from '../lib/booking.ts';
import { ClientApiError } from '../lib/client.ts';
import Checkout from './Checkout.tsx';
import HoldTimer from './HoldTimer.tsx';

export interface ScheduleBranch {
  id: string; name: string; timezone: string;
  bookingWindow: { defaultDays: number; maxDays: number };
}
export interface ScheduleResource { id: string; name: string; zone: ZoneCode; stepMinutes: number; roomName: string | null }

interface Props {
  branch: ScheduleBranch;
  resources: ScheduleResource[];
  /** Сегодня по зоне филиала – с сервера страницы. */
  today: string;
  zone: ZoneCode | null;
}

const STATE_WORD: Record<SlotState, string> = {
  free: 'свободно', mine: 'выбрано вами', held: 'удерживается другим гостем', booked: 'занято', blocked: 'на обслуживании', closed: 'вне графика',
};
const LEGEND: SlotState[] = ['free', 'mine', 'held', 'booked', 'blocked', 'closed'];
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

type Notice = { state: UiState; text: string };

export default function Schedule({ branch, resources, today, zone: initialZone }: Props) {
  const tz = branch.timezone;
  const [date, setDate] = useState(today);
  const [zone, setZone] = useState<ZoneCode | null>(initialZone);
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
  const reqNo = useRef(0);

  function adopt(h: HoldDto | null) {
    const live = h && h.status === 'active' && h.items.length > 0 ? h : null;
    holdRef.current = live;
    setHold(live);
    setDeadline(live ? holdDeadline(live) : null);
    setPhase('held');
    if (!live) setStep('pick');
    if (live) sessionStorage.setItem(holdStoreKey(branch.id), live.id);
    else sessionStorage.removeItem(holdStoreKey(branch.id));
  }

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
  const shown = resources.filter((r) => !zone || r.zone === zone);
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

  if (step === 'checkout' && hold && deadline !== null) {
    return (
      <div class="yu-sched" data-testid="schedule">
        {statusLine}
        <section class="yu-checkout" aria-labelledby="checkout-title">
          <h2 id="checkout-title" class="yu-hold__title">Оформление записи</h2>
          <HoldTimer deadline={deadline} onPhase={setPhase} onExpire={expire} />
          <Checkout
            hold={hold} timezone={tz} onHold={adopt} onNotice={setNotice}
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
        {zones.length > 1 && (
          <div class="yu-sched__zones" role="group" aria-label="Зона">
            <button type="button" class="yu-sched__zone" aria-pressed={zone === null} onClick={() => setZone(null)}>Все зоны</button>
            {zones.map((z) => (
              <button type="button" key={z} class="yu-sched__zone" aria-pressed={zone === z} onClick={() => setZone(z)}>{ZONE_LABEL[z]}</button>
            ))}
          </div>
        )}
      </div>

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
                  const active = s.state === 'free' || s.state === 'mine';
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

      {hold && deadline !== null && (
        <section class="yu-hold" aria-labelledby="hold-title" data-testid="hold-panel">
          <h2 id="hold-title" class="yu-hold__title">Ваш выбор</h2>
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
      )}
    </div>
  );
}
