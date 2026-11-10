// Праздничный календарь (S3-86, K20 §9, №379; 15 §6.4): один календарь сети плюс праздники отдельных городов, ведёт Владелец (holiday.manage), вручную.
// Влияет только на подарок имениннику: график филиала меняют исключения календаря. Удаления нет: окно внутри записи отменяет дату с причиной,
// отменённые – отдельным разделом. Директору и остальным – только чтение. Даты – локальные, без сдвига зоны.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { useLatest } from '../lib/latest.ts';
import { WEEKDAY, dayText, eventError, weekdayOf, type Holiday } from '../lib/events.ts';
import { ReasonDialog } from './EventParts.tsx';

export interface HolidayCalendarProps {
  canManage: boolean;
  cities: Array<{ id: string; name: string }>;
  year: number;
}

export default function HolidayCalendar(p: HolidayCalendarProps) {
  const [year, setYear] = useState(p.year);
  const [items, setItems] = useState<Holiday[] | null>(null);
  const [view, setView] = useState<'active' | 'cancelled'>('active');
  const [scope, setScope] = useState<'network' | 'city'>('network');
  const [cityId, setCityId] = useState(p.cities[0]?.id ?? '');
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<Holiday | null>(null);
  const key = useRef(crypto.randomUUID());
  const latest = useLatest(); // листание года: ответ прежнего года не подменяет список
  const load = async () => {
    const fresh = latest();
    try {
      const r = await browserCall<{ items: Holiday[] }>(`/holidays?from=${year}-01-01&to=${year}-12-31&includeCancelled=true`);
      if (!fresh()) return;
      setItems(r.items);
    } catch (err) {
      if (!fresh()) return;
      setError(eventError(err));
      setItems([]);
    }
  };
  useEffect(() => void load(), [year]);
  const shown = (items ?? []).filter((h) => h.status === view);
  const where = (h: Holiday) => (h.scope === 'network' ? 'Вся сеть' : (p.cities.find((c) => c.id === h.cityId)?.name ?? 'Город'));
  const add = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!date) return setError('Укажите дату.');
    if (!name.trim()) return setError('Укажите название праздника.');
    if (scope === 'city' && !cityId) return setError('Выберите город.');
    setBusy(true);
    setError('');
    try {
      await browserCall('/holidays', { method: 'POST', key: key.current, body: { scope, ...(scope === 'city' ? { cityId } : {}), date, name: name.trim() } });
      key.current = crypto.randomUUID();
      setDate('');
      setName('');
      setNotice('Дата добавлена. В этот день подарок имениннику не записывается.');
      if (date.slice(0, 4) !== String(year)) setYear(Number(date.slice(0, 4)));
      else await load();
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(eventError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="yc-panel" aria-label="Праздничный календарь" data-testid="holiday-calendar">
      <p class="yc-field__hint">Влияет только на запись подарка имениннику. Часы работы в праздник задаются исключениями календаря филиала.</p>
      {!p.canManage && <p class="yc-field__hint" data-testid="holiday-readonly">Только просмотр: даты ведёт Владелец.</p>}
      {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}
      {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      <div class="yc-ev__headline">
        <div class="yc-tabs" role="group" aria-label="Год">
          <button class="yc-btn yc-btn--ghost" type="button" aria-label="Предыдущий год" onClick={() => setYear(year - 1)}>‹</button>
          <strong data-testid="holiday-year">{year}</strong>
          <button class="yc-btn yc-btn--ghost" type="button" aria-label="Следующий год" onClick={() => setYear(year + 1)}>›</button>
        </div>
        <div class="yc-seg" role="group" aria-label="Раздел">
          <button type="button" class="yc-seg__btn" aria-pressed={view === 'active'} onClick={() => setView('active')}>Действующие</button>
          <button type="button" class="yc-seg__btn" aria-pressed={view === 'cancelled'} onClick={() => setView('cancelled')}>Отменённые</button>
        </div>
      </div>
      {items === null ? <p class="yc-empty">Загружаем…</p> : shown.length === 0 ? <p class="yc-empty" data-testid="holiday-empty">{view === 'active' ? `На ${year} год дат нет: подарок записывается во все будни.` : 'Отменённых дат нет.'}</p> : (
        <ul class="yc-ev__cards" data-testid="holiday-list">
          {shown.map((h) => (
            <li class="yc-ev__item" key={h.id} data-testid={`holiday-${h.date}`}>
              <strong>{dayText(h.date)}, {WEEKDAY[weekdayOf(h.date)]}</strong>
              <span>{h.name} · {where(h)}</span>
              {p.canManage && h.status === 'active' && <button class="yc-btn yc-btn--ghost" type="button" aria-label={`Отменить ${dayText(h.date)}`} onClick={() => setCancelling(h)}>Отменить…</button>}
            </li>
          ))}
        </ul>
      )}
      {p.canManage && (
        <form class="yc-form yc-form--wide" novalidate onSubmit={add} data-testid="holiday-form">
          <h3 class="yc-ev__h3">Добавить дату</h3>
          <div class="yc-ev__grid">
            <label class="yc-field"><span class="yc-field__label">Дата</span><input class="yc-input" type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Название</span><input class="yc-input" type="text" maxLength={200} value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
            <label class="yc-field"><span class="yc-field__label">Где действует</span>
              <select class="yc-input" value={scope} onChange={(e) => setScope(e.currentTarget.value as 'network' | 'city')}><option value="network">Вся сеть</option><option value="city">Один город</option></select></label>
            {scope === 'city' && <label class="yc-field"><span class="yc-field__label">Город</span><select class="yc-input" value={cityId} onChange={(e) => setCityId(e.currentTarget.value)}>{p.cities.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>}
          </div>
          <div><button class="yc-btn" type="submit" disabled={busy}>Добавить</button></div>
        </form>
      )}
      <ReasonDialog open={cancelling !== null} title={`Отменить праздник ${cancelling ? dayText(cancelling.date) : ''}?`} label="Причина" confirm="Отменить дату" danger testId="holiday-cancel"
        text={<p>Подарок снова можно будет записать на этот день. Запись о дате останется в разделе «Отменённые».</p>} onClose={() => setCancelling(null)}
        onConfirm={async (reason, k) => {
          await browserCall(`/holidays/${cancelling!.id}/cancel`, { method: 'POST', key: k, body: { reason } });
          setCancelling(null);
          setNotice('Дата отменена.');
          await load();
        }} />
    </section>
  );
}
