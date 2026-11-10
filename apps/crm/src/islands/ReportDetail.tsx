// Детализация показателя (S4-91; 14 §15, K24 §2, K11 №241): исходные записи с теми же фильтрами, что у карточки, и условием сегмента.
// Итог считает сервер тем же условием, что число карточки (TC-20): «Итог» показывается рядом и должен совпадать. Курсор – по 100 строк.
// Номер брони ведёт в карточку брони, операция кассы – в карточку операции (S4-95). Таблица прокручивается
// по горизонтали только внутри своего блока: страница на 390 px не уезжает. Недоступный показатель – причина словами, строк нет.
import { useEffect, useRef, useState } from 'preact/hooks';
import { BOOKING_STATUS_LABEL, METHOD_LABEL, fmtMetric, fmtValue, metricTitle, reportError, type DetailResult, type Metric, type MetricUnit } from '../lib/reports.ts';
import { getJson, reportQuery, type ReportFilters } from './ReportView.tsx';

export interface ReportDetailProps {
  report: string;
  filters: ReportFilters;
  metric: string;
  /** Условие сегмента графика (`day:2026-11-05`), пусто – весь показатель. */
  segment: string;
  segmentLabel: string;
  /** Число карточки – для сверки с итогом детализации. */
  card: Metric | undefined;
  onClose: () => void;
}

const COLUMN_TITLES: Record<string, string> = {
  number: 'Номер', startLocal: 'Начало сеанса', branchName: 'Филиал', client: 'Клиент', resourceName: 'Ресурс', minutes: 'Минут', status: 'Статус', priceKop: 'Стоимость',
  payment: 'Оплата', reasonCode: 'Причина', cancelledAt: 'Отменено', occurredLocal: 'Дата операции', kind: 'Вид', method: 'Способ', place: 'Место денег', source: 'Источник',
  amountKop: 'Сумма', comment: 'Комментарий', heldLocal: 'Дата проведения', atLocal: 'Дата', plannedMinutes: 'План, мин', paidMinutes: 'Оплачено, мин', value: 'Значение',
  unitName: 'Единица', resourceType: 'Тип ресурса', availableMin: 'Доступно, мин', bookedMin: 'Забронировано, мин', usedMin: 'Использовано, мин', freeMin: 'Свободно, мин',
  blockedMin: 'Заблокировано, мин', inventoryNo: 'Инвентарный номер', id: 'Запись',
};
const KIND_LABEL: Record<string, string> = { income: 'Поступление', refund: 'Возврат', expense: 'Расход', withdrawal: 'Изъятие', place_transfer: 'Перевод', correction: 'Исправление',
  shift: 'Смена', gap: 'Пустой интервал', entry: 'Запись зарплаты', payout_expense: 'Расход на выплату' };
const PLACE_LABEL: Record<string, string> = { cash: 'Касса', noncash: 'Безналичные' };
const SHOW = (cols: string[], rows: Array<Record<string, unknown>>) => {
  const base = cols.length ? cols : Object.keys(rows[0] ?? {});
  return rows.length && 'unitName' in (rows[0] ?? {}) ? ['unitName', 'branchName', 'resourceType', 'availableMin', 'bookedMin', 'usedMin', 'freeMin', 'value'] : base.includes('value') ? base : [...base, 'value'];
};

function cell(col: string, row: Record<string, unknown>, unit: MetricUnit | null) {
  const v = row[col];
  if (v === null || v === undefined || v === '') return '–';
  if (col === 'number' && typeof row.bookingId === 'string') return <a href={`/bookings/${encodeURIComponent(row.bookingId)}`}>№ {String(v)}</a>;
  if (col === 'number' && typeof row.eventId === 'string') return <a href={`/events/${encodeURIComponent(row.eventId)}`}>{String(v)}</a>;
  if (col === 'number' && row.occurredLocal && typeof row.id === 'string') return <a href={`/finance/operations/${encodeURIComponent(row.id)}`}>№ {String(v)}</a>;
  if (col === 'client' && typeof v === 'object') {
    const c = v as { id: string; name: string | null; phone: string };
    return <a href={`/clients/${encodeURIComponent(c.id)}`}>{c.name ?? 'Без имени'}<span class="rp-sub" style="display:block;font-size:var(--yc-fs-xs);color:var(--yc-muted)">{c.phone}</span></a>;
  }
  if (col === 'payment' && typeof v === 'object') {
    const p = v as { state: string; methods: string[]; paidKop: number };
    return p.state === 'paid' ? `оплачено: ${p.methods.map((m) => METHOD_LABEL[m] ?? m).join(', ')}` : 'не оплачено';
  }
  if (col.endsWith('Kop')) return fmtValue(Number(v), 'kop');
  if (col === 'status') return BOOKING_STATUS_LABEL[String(v)] ?? String(v);
  if (col === 'kind') return KIND_LABEL[String(v)] ?? String(v);
  if (col === 'method') return METHOD_LABEL[String(v)] ?? String(v);
  if (col === 'place') return PLACE_LABEL[String(v)] ?? String(v);
  if (col === 'cancelledAt') return new Date(String(v)).toLocaleString('ru-RU');
  if (col === 'value' && typeof v === 'number') return unit ? fmtValue(v, unit) : String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function ReportDetail({ report, filters, metric, segment, segmentLabel, card, onClose }: ReportDetailProps) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [total, setTotal] = useState<Metric | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const ctrl = useRef<AbortController | null>(null);
  const head = useRef<HTMLHeadingElement>(null);

  const load = async (after: string | null) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const p = reportQuery(filters);
    p.set('metric', metric);
    if (segment) p.set('segment', segment);
    if (after) p.set('cursor', after);
    if (!after) setState('loading');
    try {
      const r = await getJson<DetailResult>(`/reports/${report}/detail?${p}`, c.signal);
      setRows((prev) => (after ? [...prev, ...r.rows] : r.rows));
      setColumns(r.columns);
      setTotal(r.total);
      setCursor(r.nextCursor);
      setState('ready');
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(reportError(e));
      setState('error');
    }
  };
  useEffect(() => {
    setRows([]);
    void load(null);
    head.current?.focus();
    return () => ctrl.current?.abort();
  }, [report, metric, segment, JSON.stringify(filters)]);

  const unit = total?.state === 'ok' ? total.unit : null;
  const cols = SHOW(columns, rows);
  const same = !segment && card && total && fmtMetric(card) === fmtMetric(total);

  return (
    <section class="rp-detail" style="display:grid;gap:var(--yc-sp-xs);min-width:0" aria-labelledby="rp-detail-h" data-testid="detail" data-state={state}>
      <div class="rp-detail__head" style="display:flex;flex-wrap:wrap;gap:var(--yc-sp-xs);align-items:center;justify-content:space-between">
        <h2 id="rp-detail-h" tabIndex={-1} ref={head}>{metricTitle(metric)}: записи{segmentLabel ? ` – ${segmentLabel}` : ''}</h2>
        <button class="yc-btn yc-btn--ghost" type="button" onClick={onClose}>Закрыть</button>
      </div>
      {state === 'loading' && <p class="yc-empty" role="status">Загружаем записи…</p>}
      {state === 'error' && <p class="yc-alert yc-alert--error" role="alert" data-testid="detail-error">{error}</p>}
      {total && (
        <p class="rp-detail__total" data-testid="detail-total">
          Итог: <strong>{fmtMetric(total)}</strong>
          {same && <span> – совпадает с карточкой</span>}
          {rows.length > 0 && <span> · строк загружено: {rows.length}{cursor ? ', есть ещё' : ''}</span>}
        </p>
      )}
      {state === 'ready' && rows.length === 0 && total?.state !== 'unavailable' && <p class="yc-empty" data-testid="detail-empty">За период записей нет.</p>}
      {rows.length > 0 && (
        <div class="rp-scroll" data-testid="detail-scroll">
          <table class="rp-table" data-testid="detail-table">
            <thead><tr>{cols.map((c) => <th scope="col" key={c}>{COLUMN_TITLES[c] ?? c}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={String(r.bookingId ?? r.id ?? r.unitId ?? i)}>{cols.map((c) => <td key={c}>{cell(c, r, unit)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {cursor && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void load(cursor)}>Показать ещё</button>}
    </section>
  );
}
