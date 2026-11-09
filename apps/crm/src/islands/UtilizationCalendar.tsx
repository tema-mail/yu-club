// Календарь загрузки единицы (S4-92; K11 №242, 14 §6): за выбранный день – часы работы, брони, блокировки и свободное время одной
// единицы (места). VR1 и VR2 – разные единицы, аренда комнаты целиком видна на каждой. Время – по зоне филиала (K8); цвет каждого
// вида подписан словом и в полосе, и в списке интервалов.
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtTime, reportError, type Interval, type UnitCalendar } from '../lib/reports.ts';
import { getJson } from './ReportView.tsx';

export interface UtilizationCalendarProps { unitId: string; unitName: string; date: string; timezone: string; onClose: () => void }

const KINDS = [
  { key: 'booked', label: 'Забронировано', color: '#1f4fb8' },
  { key: 'blocked', label: 'Заблокировано', color: '#a61b1b' },
  { key: 'free', label: 'Свободно', color: '#e6f4ec' },
] as const;

export default function UtilizationCalendar({ unitId, unitName, date: initialDate, timezone, onClose }: UtilizationCalendarProps) {
  const [date, setDate] = useState(initialDate);
  const [cal, setCal] = useState<UnitCalendar | null>(null);
  const [error, setError] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setCal(null);
    setError('');
    getJson<UnitCalendar>(`/reports/utilization/calendar?${new URLSearchParams({ unitId, date })}`, c.signal)
      .then(setCal)
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setError(reportError(e)); });
    return () => c.abort();
  }, [unitId, date]);

  const open = cal?.open ?? [];
  const start = open.length ? Math.min(...open.map((x) => Date.parse(x.start))) : 0;
  const end = open.length ? Math.max(...open.map((x) => Date.parse(x.end))) : 1;
  const pos = (iv: Interval) => ({ left: `${((Date.parse(iv.start) - start) / (end - start)) * 100}%`, width: `${((Date.parse(iv.end) - Date.parse(iv.start)) / (end - start)) * 100}%` });
  const span = (iv: Interval) => `${fmtTime(iv.start, timezone)}–${fmtTime(iv.end, timezone)}`;

  return (
    <section class="rp-cal" aria-labelledby={`cal-${unitId}`} data-testid={`calendar-${unitName}`} style="display:grid;gap:var(--yc-sp-xs);padding:var(--yc-sp-s);background:var(--yc-surface);border:1px solid var(--yc-line);border-radius:var(--yc-r-m);min-width:0">
      <div style="display:flex;flex-wrap:wrap;gap:var(--yc-sp-xs);align-items:end;justify-content:space-between">
        <h3 id={`cal-${unitId}`} style="margin:0">Календарь загрузки: {unitName}</h3>
        <label class="yc-field"><span class="yc-field__label">День</span>
          <input class="yc-input" type="date" name="calendarDate" value={date} onChange={(e) => setDate((e.target as HTMLInputElement).value)} /></label>
        <button class="yc-btn yc-btn--ghost" type="button" onClick={onClose}>Закрыть календарь</button>
      </div>
      {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      {!cal && !error && <p class="yc-empty" role="status">Загружаем календарь…</p>}
      {cal && open.length === 0 && <p class="yc-empty" data-testid="calendar-closed">В этот день единица не работала: филиал закрыт или единицы ещё нет.</p>}
      {cal && open.length > 0 && (
        <>
          <p style="margin:0;font-size:var(--yc-fs-xs);color:var(--yc-muted)">Часы работы: {open.map(span).join(', ')} (время филиала)</p>
          <div role="img" aria-label="Полоса дня: брони, блокировки и свободное время" style="position:relative;height:2rem;background:var(--yc-surface-2);border-radius:var(--yc-r-s);overflow:hidden">
            {KINDS.flatMap((k) => cal[k.key].map((iv) => (
              <span key={`${k.key}${iv.start}`} title={`${k.label}: ${span(iv)}`} style={{ position: 'absolute', top: 0, bottom: 0, ...pos(iv), background: k.color, borderRight: '1px solid #fff' }} />
            )))}
          </div>
          <ul style="list-style:none;margin:0;padding:0;display:grid;gap:var(--yc-sp-2xs);font-size:var(--yc-fs-s)">
            {KINDS.map((k) => (
              <li key={k.key} data-testid={`cal-${k.key}`} style="display:flex;flex-wrap:wrap;gap:var(--yc-sp-2xs);align-items:center">
                <svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="2" fill={k.color} stroke="#4a5260" stroke-width="0.5" /></svg>
                <strong>{k.label}:</strong> {cal[k.key].length ? cal[k.key].map(span).join(', ') : 'нет'}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
