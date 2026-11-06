// Брони и ресурсы мероприятия (S3-83, K20 §4, №365–366, TC-13): комната и правила праздника – проверка до сохранения (комната целиком,
// не короче настройки, длительность по формату), окончательно решает сервер. Освобождение – окном с причиной, перенос двигает все занятые
// ресурсы одним сдвигом: конфликт оставляет прежнее время. Связанные брони – только ссылки: мероприятие ими не управляет. Время – зона филиала.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { inZone } from '../lib/booking.ts';
import { atText, eventError, isClosed, periodText, toIso, PARTY_FORMAT, type EventResource } from '../lib/events.ts';
import { Modal, ReasonDialog, type EventTabProps } from './EventParts.tsx';

interface ResourceOption { id: string; name: string; type: string; status: string }
interface BookingOption { id: string; number: number; start: string; end: string; resourceName: string; client: { name: string | null } }

/** Все ресурсы филиала: проходим курсор до конца (limit ≤ 100). */
async function allResources(branchId: string): Promise<ResourceOption[]> {
  const out: ResourceOption[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const r: { items: ResourceOption[]; nextCursor?: string | null } = await browserCall(`/branches/${branchId}/resources?limit=100${q}`);
    out.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

/** Правила платного праздника до сохранения: то, что можно проверить без сервера (K20 §4). null – замечаний нет. */
export function partyProblem(type: string, minutes: number, minMinutes: number, format: string | null): string | null {
  if (type !== 'room_whole') return 'Праздник проходит только в комнате VR+PS4 целиком.';
  if (minutes < minMinutes) return `Праздник – непрерывно не меньше ${minMinutes} минут.`;
  if (format === 'h2' && minutes !== 120) return `Формат «${PARTY_FORMAT.h2}» – ровно 120 минут.`;
  if (format === 'h3plus' && minutes < 180) return `Формат «${PARTY_FORMAT.h3plus}» – от 180 минут.`;
  return null;
}

export default function EventResources(p: EventTabProps & { minMinutes: number }) {
  const c = p.card;
  const tz = c.timezone;
  const startL = c.plannedStart ? inZone(c.plannedStart, tz) : null;
  const endL = c.plannedEnd ? inZone(c.plannedEnd, tz) : null;
  const [options, setOptions] = useState<ResourceOption[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [date, setDate] = useState(startL?.date ?? '');
  const [from, setFrom] = useState(startL?.hm ?? '');
  const [to, setTo] = useState(endL?.hm ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState<EventResource | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [mv, setMv] = useState({ date: '', from: '', to: '', reason: '' });
  const [mvError, setMvError] = useState('');
  const [bookings, setBookings] = useState<BookingOption[] | null>(null);
  const [bookingId, setBookingId] = useState('');
  const key = useRef(crypto.randomUUID());
  const canEdit = p.actions.includes('event.manage') && !isClosed(c.status);
  const active = c.resources.filter((r) => r.status === 'active');
  const released = c.resources.filter((r) => r.status === 'released');
  const isParty = c.typeCode === 'birthday_party';
  const chosen = options.find((o) => o.id === resourceId);
  const toMs = (d: string, hm: string) => (d && hm ? Date.parse(toIso(d, hm, tz)!) : NaN);
  const minutes = (toMs(date, to) - toMs(date, from)) / 60_000;
  const problem = isParty && chosen && minutes > 0 ? partyProblem(chosen.type, minutes, p.minMinutes, c.party?.format ?? null) : null;

  useEffect(() => {
    allResources(c.branchId).then((all) => {
      const list = all.filter((x) => x.status === 'active');
      setOptions(list);
      setResourceId((isParty ? list.find((x) => x.type === 'room_whole') : list[0])?.id ?? '');
    }, () => setError('Не удалось загрузить ресурсы филиала. Обновите страницу.'));
  }, [c.branchId]);
  useEffect(() => {
    if (!canEdit || !startL) return;
    browserCall<{ items: BookingOption[] }>(`/branches/${c.branchId}/bookings?date=${startL.date}&limit=100`).then((r) => {
      const free = r.items.filter((b) => !c.bookingIds.includes(b.id));
      setBookings(free);
      setBookingId(free[0]?.id ?? '');
    }, () => setBookings([]));
  }, [c.branchId, startL?.date, c.bookingIds.length]);

  const reserve = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!resourceId) return setError('Выберите ресурс.');
    if (!date || !from || !to) return setError('Укажите дату, начало и конец.');
    if (!(minutes > 0)) return setError('Конец должен быть позже начала.');
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}/resources`, { method: 'POST', key: key.current, body: { resourceId, start: toIso(date, from, tz), end: toIso(date, to, tz) } });
      key.current = crypto.randomUUID();
      await p.onChanged(`Занято: ${chosen?.name ?? 'ресурс'}.`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };

  const openMove = () => {
    setMv({ date: startL?.date ?? '', from: startL?.hm ?? '', to: endL?.hm ?? '', reason: '' });
    setMvError('');
    key.current = crypto.randomUUID();
    setMoving(true);
  };
  const move = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!mv.date || !mv.from || !mv.to) return setMvError('Укажите новую дату, начало и конец.');
    if (!mv.reason.trim()) return setMvError('Укажите причину переноса.');
    const ps = toMs(mv.date, mv.from);
    const pe = toMs(mv.date, mv.to);
    if (!(pe > ps)) return setMvError('Конец должен быть позже начала.');
    const shift = c.plannedStart ? ps - Date.parse(c.plannedStart) : 0;
    const resources = active.map((r) => ({ eventResourceId: r.id, resourceId: r.resourceId, start: new Date(Date.parse(r.start) + shift).toISOString(), end: new Date(Date.parse(r.end) + shift).toISOString() }));
    if (resources.some((r) => Date.parse(r.start) < ps || Date.parse(r.end) > pe)) return setMvError('Занятый ресурс не помещается в новое время: измените конец или сначала освободите ресурс.');
    setBusy(true);
    setMvError('');
    try {
      await browserCall(`/events/${c.id}/move`, { method: 'POST', key: key.current, body: { rowVersion: c.rowVersion, plannedStart: new Date(ps).toISOString(), plannedEnd: new Date(pe).toISOString(), resources, reason: mv.reason.trim() } });
      setMoving(false);
      await p.onChanged('Мероприятие перенесено.');
    } catch (err) {
      key.current = crypto.randomUUID();
      setMvError(eventError(err));
      if (err instanceof ApiError && (err.code === 'EVENT_MOVE_RESOURCES_INVALID' || err.code === 'VERSION_CONFLICT')) await p.onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const link = async () => {
    if (busy || !bookingId) return;
    setBusy(true);
    setError('');
    try {
      await browserCall(`/events/${c.id}/bookings`, { method: 'POST', body: { bookingId } });
      await p.onChanged('Бронь связана с мероприятием.');
    } catch (err) {
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 class="yc-ev__h3">Занятые ресурсы</h3>
      {active.length === 0 ? <p class="yc-empty" data-testid="no-resources">Ничего не занято. Обычная бронь мероприятию не нужна: комнату занимают здесь.</p> : (
        <ul class="yc-ev__cards" data-testid="event-resources">
          {active.map((r) => (
            <li class="yc-ev__item" key={r.id} data-testid={`res-${r.resourceName}`}>
              <strong>{r.resourceName}</strong>
              <span>{periodText(r.start, r.end, tz)}</span>
              {r.requestHold && <span class="yc-ev__warn" data-testid="hold-until">Заявка не обработана: снимется {atText(r.requestHold.expiresAt, tz)}{r.requestHold.remind ? ' – пора решать' : ''}</span>}
              {canEdit && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setReleasing(r)}>Освободить…</button>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && c.plannedStart && <div><button class="yc-btn yc-btn--ghost" type="button" onClick={openMove}>Перенести…</button></div>}
      {released.length > 0 && (
        <details class="yc-ev__removed"><summary>Освобождённые: {released.length}</summary>
          <ul class="yc-history">{released.map((r) => <li class="yc-history__item" key={r.id}><span class="yc-history__head">{r.resourceName}, {periodText(r.start, r.end, tz)}</span><span>Причина: {r.releaseReason}</span></li>)}</ul>
        </details>
      )}
      {canEdit && (
        <form class="yc-form yc-form--wide" novalidate onSubmit={reserve} data-testid="reserve-form">
          <h3 class="yc-ev__h3">Занять ресурс</h3>
          {isParty && <p class="yc-field__hint">Праздник: только комната целиком, непрерывно не меньше {p.minMinutes} минут{c.party ? `, формат «${PARTY_FORMAT[c.party.format]}»` : ''}.</p>}
          <label class="yc-field"><span class="yc-field__label">Ресурс</span>
            <select class="yc-input" value={resourceId} onChange={(e) => setResourceId(e.currentTarget.value)}>{options.map((o) => <option value={o.id}>{o.name}</option>)}</select></label>
          <div class="yc-ev__grid">
            <label class="yc-field"><span class="yc-field__label">Дата</span><input class="yc-input" type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} /></label>
            <div class="yc-ev__row">
              <label class="yc-field"><span class="yc-field__label">С</span><input class="yc-input" type="time" step={300} value={from} onInput={(e) => setFrom(e.currentTarget.value)} /></label>
              <label class="yc-field"><span class="yc-field__label">До</span><input class="yc-input" type="time" step={300} value={to} onInput={(e) => setTo(e.currentTarget.value)} /></label>
            </div>
          </div>
          {problem && <p class="yc-alert yc-alert--warn" data-testid="party-problem">{problem}</p>}
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div><button class="yc-btn" type="submit" disabled={busy}>Занять</button></div>
        </form>
      )}

      <h3 class="yc-ev__h3">Связанные брони</h3>
      <p class="yc-field__hint">Только ссылки: мероприятие ими не управляет; при отмене они попадут в список «требует решения».</p>
      {c.bookingIds.length === 0 ? <p class="yc-empty">Связанных броней нет.</p> : (
        <ul class="yc-ev__cards" data-testid="event-bookings">
          {c.bookingIds.map((id, i) => (
            <li class="yc-ev__item" key={id}>
              <a href={`/bookings/${id}`}>Бронь {i + 1}: открыть</a>
              {canEdit && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setUnlinking(id)}>Снять связь…</button>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && bookings !== null && bookings.length > 0 && (
        <div class="yc-ev__row" data-testid="link-booking">
          <label class="yc-field"><span class="yc-field__label">Бронь в день мероприятия</span>
            <select class="yc-input" value={bookingId} onChange={(e) => setBookingId(e.currentTarget.value)}>{bookings.map((b) => <option value={b.id}>№{b.number}, {periodText(b.start, b.end, tz)}, {b.resourceName}</option>)}</select></label>
          <button class="yc-btn yc-btn--ghost" type="button" disabled={busy} onClick={link}>Связать</button>
        </div>
      )}

      <ReasonDialog open={releasing !== null} title={`Освободить «${releasing?.resourceName ?? ''}»?`} label="Причина" confirm="Освободить" danger testId="release-dialog"
        text={<p>Время снова станет свободным для записи. Строка останется в истории мероприятия.</p>} onClose={() => setReleasing(null)}
        onConfirm={async (reason, k) => {
          await browserCall(`/events/${c.id}/resources/${releasing!.id}/release`, { method: 'POST', key: k, body: { reason } });
          setReleasing(null);
          await p.onChanged('Ресурс освобождён.');
        }} />
      <Modal open={unlinking !== null} title="Снять связь с бронью?" onClose={() => setUnlinking(null)} testId="unlink-dialog">
        <p>Сама бронь не изменится: уйдёт только ссылка из мероприятия.</p>
        <div class="yc-dialog__actions">
          <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setUnlinking(null)}>Назад</button>
          <button class="yc-btn yc-btn--danger" type="button" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await browserCall(`/events/${c.id}/bookings/${unlinking!}/unlink`, { method: 'POST', body: {} });
              setUnlinking(null);
              await p.onChanged('Связь с бронью снята.');
            } catch (err) {
              setUnlinking(null);
              setError(eventError(err));
            } finally {
              setBusy(false);
            }
          }}>Снять связь</button>
        </div>
      </Modal>
      <Modal open={moving} title={`Перенести ${c.number}`} onClose={() => setMoving(false)} testId="move-dialog">
        <form class="yc-ev__stack" novalidate onSubmit={move}>
          <p>Сейчас: {periodText(c.plannedStart, c.plannedEnd, tz)}. Занятые ресурсы сдвинутся вместе с мероприятием; если новое время занято, прежнее останется.</p>
          <label class="yc-field"><span class="yc-field__label">Новая дата</span><input class="yc-input" type="date" value={mv.date} onInput={(e) => setMv({ ...mv, date: e.currentTarget.value })} /></label>
          <div class="yc-ev__row">
            <label class="yc-field"><span class="yc-field__label">Начало</span><input class="yc-input" type="time" step={300} value={mv.from} onInput={(e) => setMv({ ...mv, from: e.currentTarget.value })} /></label>
            <label class="yc-field"><span class="yc-field__label">Конец</span><input class="yc-input" type="time" step={300} value={mv.to} onInput={(e) => setMv({ ...mv, to: e.currentTarget.value })} /></label>
          </div>
          <label class="yc-field"><span class="yc-field__label">Причина переноса</span><textarea class="yc-input" rows={2} maxLength={2000} value={mv.reason} onInput={(e) => setMv({ ...mv, reason: e.currentTarget.value })} /></label>
          {mvError && <p class="yc-alert yc-alert--error" role="alert">{mvError}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => setMoving(false)}>Назад</button>
            <button class="yc-btn" type="submit" disabled={busy}>Перенести</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
