// Экран отчёта (S4-90; 14 §15, K24 §2, §9, K11 №240): название и назначение, период (быстрые и свой), город и филиал зоны, фильтры
// отчёта, «Сформировать», итоговые карточки со сравнением, таблица точных значений, время расчёта и правило суток.
// Смена фильтра отменяет прежний запрос (AbortController) и сбрасывает показанный итог: старые и новые данные не смешиваются –
// ответ, пришедший не на последний запрос, отбрасывается. Тяжёлые отчёты (3.3, 3.6) при периоде > 31 дня считаются только по кнопке.
// Смена города сбрасывает филиал, смена филиала – зависимые фильтры. Сравнение при нулевой базе – «–», недоступное – словами.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, API_PREFIX } from '../lib/api.ts';
import ReportChart from './ReportChart.tsx';
import ReportDetail from './ReportDetail.tsx';
import UtilizationCalendar from './UtilizationCalendar.tsx';
import {
  BOOKING_STATUS_LABEL, METHOD_LABEL, RESOURCE_TYPE_LABEL, dateBasisOf, daysIn, fmtAt, fmtDelta, fmtMetric, fmtPeriod, metricTitle, presets, reportError, todayIn,
  type Metric, type ReportInfo, type ReportResult,
} from '../lib/reports.ts';

export interface ZoneBranch { id: string; name: string; cityId: string; cityName: string; timezone: string }
export interface ReportFilters { from: string; to: string; cityId: string; branchId: string; resourceType: string; status: string; method: string }
export interface ReportViewProps {
  report: Pick<ReportInfo, 'key' | 'title' | 'purpose' | 'filters' | 'heavy'>;
  initial: ReportFilters;
  /** Показатель детализации из адреса (?metric=). */
  metric: string;
  branches: ZoneBranch[];
  /** Город целиком можно выбрать: сеть или назначение на город. */
  cityIds: string[];
  network: boolean;
  timezone: string;
}

const HEAVY_DAYS = 31;

/** GET с отменой: browserCall сигнал не принимает, ошибка – тем же ApiError. */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', ...(signal ? { signal } : {}) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
    throw new ApiError(res.status, body.error?.code ?? 'INTERNAL', body.error?.message ?? 'Ошибка сервера', body.error?.details);
  }
  return (await res.json()) as T;
}

/** Параметры запроса отчёта – те же для экрана, детализации и экспорта (K24 §7). */
export function reportQuery(f: ReportFilters): URLSearchParams {
  const p = new URLSearchParams({ from: f.from, to: f.to });
  if (f.branchId) p.set('branchIds', f.branchId);
  else if (f.cityId) p.set('cityId', f.cityId);
  for (const k of ['resourceType', 'status', 'method'] as const) if (f[k]) p.set(k, f[k]);
  return p;
}

const OPTIONS: Record<'resourceType' | 'status' | 'method', { label: string; values: Record<string, string> }> = {
  resourceType: { label: 'Тип ресурса', values: RESOURCE_TYPE_LABEL },
  status: { label: 'Статус брони', values: BOOKING_STATUS_LABEL },
  method: { label: 'Способ оплаты', values: METHOD_LABEL },
};

export default function ReportView({ report, initial, metric: initialMetric, branches, cityIds, network, timezone }: ReportViewProps) {
  const [f, setF] = useState<ReportFilters>(initial);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [useExport, setUseExport] = useState(false);
  const [metric, setMetric] = useState(initialMetric);
  const [applied, setApplied] = useState<ReportFilters>(initial);
  const [unit, setUnit] = useState('');
  const [segment, setSegment] = useState<{ key: string; label: string }>({ key: '', label: '' });
  const seq = useRef(0);
  const ctrl = useRef<AbortController | null>(null);

  const cities = [...new Map(branches.map((b) => [b.cityId, b.cityName])).entries()];
  const cityBranches = branches.filter((b) => !f.cityId || b.cityId === f.cityId);
  const today = todayIn(timezone);
  const presetList = presets(today);
  const preset = presetList.find((p) => p.period.from === f.from && p.period.to === f.to)?.key ?? 'custom';
  const needsButton = Boolean(report.heavy) && f.from <= f.to && daysIn({ from: f.from, to: f.to }) > HEAVY_DAYS;
  const area = f.branchId ? (branches.find((b) => b.id === f.branchId)?.name ?? '') : f.cityId ? `${cities.find(([id]) => id === f.cityId)?.[1] ?? ''} – весь город` : network ? 'Вся сеть' : 'Вся ваша зона';

  const load = async (next: ReportFilters) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const mine = ++seq.current;
    setResult(null);
    setSegment({ key: '', label: '' });
    setError('');
    setUseExport(false);
    if (next.from > next.to) {
      setState('error');
      setError('Начало периода позже конца.');
      return;
    }
    setState('loading');
    try {
      const p = reportQuery(next);
      if (report.key === 'utilization') p.set('series', 'day'); // график по дням (K11 №240 series)
      const r = await getJson<ReportResult>(`/reports/${report.key}?${p}`, c.signal);
      if (mine !== seq.current) return; // ответ на прежние фильтры – не показываем
      setApplied(next);
      setResult(r);
      setState('ready');
    } catch (e) {
      if ((e as Error).name === 'AbortError' || mine !== seq.current) return;
      setError(reportError(e));
      setUseExport(e instanceof ApiError && e.details?.useExport === true);
      setState('error');
    }
  };

  const syncUrl = (next: ReportFilters, m: string) => {
    const p = reportQuery(next);
    if (next.cityId && next.branchId) p.set('cityId', next.cityId);
    if (m) p.set('metric', m);
    history.replaceState(null, '', `/reports/${report.key}?${p}`);
  };

  const change = (patch: Partial<ReportFilters>) => {
    const next = { ...f, ...patch };
    if ('cityId' in patch && patch.cityId !== f.cityId) next.branchId = ''; // филиал другого города не остаётся
    if ('branchId' in patch && patch.branchId !== f.branchId) Object.assign(next, { resourceType: '', status: '', method: '' }); // зависимые фильтры
    setF(next);
    syncUrl(next, metric);
    const heavy = Boolean(report.heavy) && next.from <= next.to && daysIn({ from: next.from, to: next.to }) > HEAVY_DAYS;
    if (heavy) {
      ctrl.current?.abort();
      seq.current++;
      setResult(null);
      setState('idle');
    } else void load(next);
  };

  useEffect(() => {
    if (!needsButton) void load(f);
    return () => ctrl.current?.abort();
  }, []);

  const pick = (key: string) => {
    const m = key === metric && !segment.key ? '' : key;
    setSegment({ key: '', label: '' });
    setMetric(m);
    syncUrl(f, m);
  };

  const metrics = result ? Object.entries(result.metrics) : [];
  const labels = result?.labels ? Object.entries(result.labels) : [];
  const sections = sectionsOf(report.key, metrics);

  return (
    <div class="rp" data-testid="report" data-state={state} data-period={result ? `${result.period.from}..${result.period.to}` : ''}>
      <p class="rp__purpose">{report.purpose}</p>
      <form class="rp-filters" aria-label="Фильтры отчёта" onSubmit={(e) => { e.preventDefault(); void load(f); }}>
        <label class="yc-field">
          <span class="yc-field__label">Период</span>
          <select class="yc-input" name="preset" value={preset} onChange={(e) => {
            const p = presetList.find((x) => x.key === (e.target as HTMLSelectElement).value);
            if (p) change({ from: p.period.from, to: p.period.to });
          }}>
            {presetList.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            <option value="custom">Свой период</option>
          </select>
        </label>
        <label class="yc-field"><span class="yc-field__label">С</span>
          <input class="yc-input" type="date" name="from" value={f.from} onChange={(e) => change({ from: (e.target as HTMLInputElement).value })} /></label>
        <label class="yc-field"><span class="yc-field__label">По</span>
          <input class="yc-input" type="date" name="to" value={f.to} onChange={(e) => change({ to: (e.target as HTMLInputElement).value })} /></label>
        {cities.length > 1 && (
          <label class="yc-field"><span class="yc-field__label">Город</span>
            <select class="yc-input" name="cityId" value={f.cityId} onChange={(e) => change({ cityId: (e.target as HTMLSelectElement).value })}>
              <option value="">{network ? 'Вся сеть' : 'Вся зона'}</option>
              {cities.map(([id, name]) => <option key={id} value={id} disabled={!network && !cityIds.includes(id) && !branches.some((b) => b.cityId === id)}>{name}</option>)}
            </select></label>
        )}
        {branches.length > 1 && (
          <label class="yc-field"><span class="yc-field__label">Филиал</span>
            <select class="yc-input" name="branchId" value={f.branchId} onChange={(e) => change({ branchId: (e.target as HTMLSelectElement).value })}>
              <option value="">Все филиалы</option>
              {cityBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></label>
        )}
        {report.filters.map((k) => (
          <label class="yc-field" key={k}><span class="yc-field__label">{OPTIONS[k].label}</span>
            <select class="yc-input" name={k} value={f[k]} onChange={(e) => change({ [k]: (e.target as HTMLSelectElement).value })}>
              <option value="">Все</option>
              {Object.entries(OPTIONS[k].values).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
        ))}
        <div class="rp-filters__go">
          <button class="yc-btn" type="submit" disabled={state === 'loading'}>{result ? 'Обновить' : 'Сформировать'}</button>
        </div>
      </form>

      <p class="rp__meta" data-testid="report-meta">
        <span>Область: {area}</span>
        <span>Период: {fmtPeriod({ from: f.from, to: f.to })}</span>
        {result && <span>Сравнение: {fmtPeriod(result.prevPeriod)}</span>}
        {result && <span data-testid="computed-at">Рассчитано: {fmtAt(result.computedAt, timezone)}</span>}
        <span>{result?.dayRule ?? 'Сутки – по времени каждого филиала'}</span>
      </p>

      {state === 'idle' && needsButton && <p class="yc-empty" data-testid="needs-run">Период длиннее {HEAVY_DAYS} дней – отчёт тяжёлый. Нажмите «Сформировать».</p>}
      {state === 'loading' && <p class="yc-empty" role="status" data-testid="report-loading">Считаем отчёт…</p>}
      {state === 'error' && (
        <div class="yc-alert yc-alert--error" role="alert" data-testid="report-error">
          {error}
          {useExport && <> Длинный период можно выгрузить файлом – кнопка «Сформировать файл».</>}
          <button class="yc-link" type="button" onClick={() => void load(f)}>Повторить</button>
        </div>
      )}

      {result && (
        <>
          {sections.map((sec) => (
            <div key={sec.title} class="rp-section" data-testid={`section-${sec.title}`} style="display:grid;gap:var(--yc-sp-2xs);min-width:0">
              {sections.length > 1 && <h2 style="margin:0;font-size:var(--yc-fs-m)">{sec.title}</h2>}
              {sec.hidden ? <p class="yc-empty" data-testid="money-hidden" style="margin:0">{sec.hidden}</p> : (
                <ul class="rp-cards" data-testid="cards">
                  {sec.items.map(([key, m]) => (
                    <li key={key}>
                      <button type="button" class={`rp-card${m.state !== 'ok' ? ' rp-card--muted' : ''}`} data-testid={`card-${key}`} aria-pressed={metric === key} onClick={() => pick(key)}>
                        <span class="rp-card__title">{metricTitle(key)}</span>
                        <span class="rp-card__value" data-testid="value">{fmtMetric(m)}</span>
                        <span class="rp-card__delta" data-testid="delta">к прошлому периоду: {fmtDelta(m)}</span>
                        {dateBasisOf(result, key) && <span class="rp-card__basis">{dateBasisOf(result, key)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {labels.length > 0 && <ul class="rp__notes">{labels.map(([k, t]) => <li key={k}>{t}</li>)}</ul>}
          <div class="rp-scroll">
            <table class="rp-table" data-testid="metrics-table">
              <caption>Точные значения</caption>
              <thead><tr><th scope="col">Показатель</th><th scope="col">Значение</th><th scope="col">Прошлый период</th><th scope="col">Изменение</th></tr></thead>
              <tbody>
                {sections.flatMap((x) => x.items).map(([key, m]) => (
                  <tr key={key}>
                    <th scope="row">{metricTitle(key)}</th>
                    <td>{fmtMetric(m)}</td>
                    <td>{prevText(m)}</td>
                    <td>{fmtDelta(m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {groupTables(result).map((g) => (
            <div class="rp-scroll" key={g.title}>
              <table class="rp-table" data-testid={`group-${g.title}`}>
                <caption>{g.title}</caption>
                <tbody>{g.rows.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody>
              </table>
            </div>
          ))}
          {result.series && result.series.points.length > 1 && (
            <ReportChart title="Загрузка по дням" unit="minutes" buckets={result.series.points.map((x) => ({ key: x.bucket, label: x.bucket.slice(8), period: fmtPeriod({ from: x.bucket, to: x.bucket }) }))}
              series={[
                { key: 'booked', label: 'забронировано', color: '#7aa2e8', colorName: 'Голубой', values: result.series.points.map((x) => x.bookedMin) },
                { key: 'used', label: 'использовано', color: '#1f4fb8', colorName: 'Синий', values: result.series.points.map((x) => x.usedMin) },
              ]}
              pickLabel="Единицы за этот день"
              onPick={(day, label) => { setMetric('used'); setSegment({ key: `day:${day}`, label }); syncUrl(f, 'used'); }} />
          )}
          {result.rows && result.rows.length > 0 && (
            <div class="rp-units" style="display:grid;gap:var(--yc-sp-xs);min-width:0">
              <label class="yc-field" style="max-width:24rem"><span class="yc-field__label">Календарь загрузки единицы</span>
                <select class="yc-input" name="unitId" value={unit} onChange={(e) => setUnit((e.target as HTMLSelectElement).value)}>
                  <option value="">Выберите единицу</option>
                  {result.rows.map((u) => <option key={u.unitId} value={u.unitId}>{u.unitName} – {u.branchName}</option>)}
                </select></label>
              {(() => {
                const u = result.rows.find((x) => x.unitId === unit);
                return u ? <UtilizationCalendar key={u.unitId} unitId={u.unitId} unitName={u.unitName} date={applied.to < today ? applied.to : today}
                  timezone={branches.find((b) => b.id === u.branchId)?.timezone ?? timezone} onClose={() => setUnit('')} /> : null;
              })()}
            </div>
          )}
          {metric && Object.hasOwn(result.metrics, metric) && (
            <ReportDetail report={report.key} filters={applied} metric={metric} segment={segment.key} segmentLabel={segment.label} card={result.metrics[metric]} onClose={() => { setSegment({ key: '', label: '' }); setMetric(''); syncUrl(f, ''); }} />
          )}
        </>
      )}
    </div>
  );
}

// ---- отчёты Э3 (S4-98; 14 §8, §12, §13): показатели по смыслу; деньги сотрудников без права – скрыты целиком, а не нулями

const E3_SECTIONS: Record<string, Array<{ title: string; keys: string[]; money?: boolean }>> = {
  events: [
    { title: 'Мероприятия', keys: ['count', 'cancelled', 'withoutBooking'] },
    { title: 'Деньги мероприятий', keys: ['agreedPrice', 'avgPrice', 'received', 'refunded', 'due'] },
    { title: 'Себестоимость и результат', keys: ['plannedCost', 'factCost', 'deviation', 'result'] },
  ],
  staff: [
    { title: 'Смены', keys: ['plannedShifts', 'workedShifts', 'noShows', 'unclosedShifts', 'shortShifts', 'plannedMinutes', 'paidMinutes'] },
    { title: 'Пустые интервалы', keys: ['emptyIntervals', 'emptyMinutes'] },
    { title: 'Деньги сотрудников', keys: ['accrued', 'hoursAmount', 'perShift', 'penalties', 'bonuses', 'adjustments', 'toPay', 'paid', 'payoutExpense', 'forecast'], money: true },
  ],
  equipment: [
    { title: 'Парк оборудования', keys: ['totalEquipment', 'inService', 'faulty', 'openFaults'] },
    { title: 'Поломки и ремонт', keys: ['incidents', 'warrantyRepairs', 'avgRepairMinutes', 'downtimeMinutes', 'repeatBreakdowns'] },
    { title: 'Расходы на ремонт', keys: ['repairExpenses'] },
  ],
};

type Entry = [string, Metric];
function sectionsOf(report: string, metrics: Entry[]): Array<{ title: string; items: Entry[]; hidden?: string }> {
  const plan = E3_SECTIONS[report];
  if (!plan) return [{ title: 'Показатели', items: metrics }];
  const byKey = new Map(metrics);
  const out = plan.map((sec) => {
    const items = sec.keys.filter((k) => byKey.has(k)).map((k): Entry => [k, byKey.get(k)!]);
    const denied = sec.money && items.length > 0 && items.every(([, m]) => m.state === 'unavailable' && m.reason === 'not_permitted');
    return denied ? { title: sec.title, items: [], hidden: 'Суммы сотрудников скрыты: нет права на зарплатные данные.' } : { title: sec.title, items };
  });
  const rest = metrics.filter(([k]) => !plan.some((x) => x.keys.includes(k)));
  return rest.length ? [...out, { title: 'Прочее', items: rest }] : out;
}

const EVENT_STATUS: Record<string, string> = { held: 'Проведено', planned: 'Запланировано', cancelled: 'Отменено', not_held: 'Не состоялось' };
function groupTables(r: ReportResult): Array<{ title: string; rows: Array<[string, string]> }> {
  const g = (r.groups ?? {}) as { byStatus?: Array<{ status: string; count: number }>; costStructure?: Array<{ kind: string; amountKop: number }>; expensesByContractor?: Array<{ contractorId: string | null; amountKop: number }> };
  const out: Array<{ title: string; rows: Array<[string, string]> }> = [];
  if (g.byStatus?.length) out.push({ title: 'Мероприятия по статусам', rows: g.byStatus.map((x) => [EVENT_STATUS[x.status] ?? x.status, String(x.count)]) });
  if (g.costStructure?.length) out.push({ title: 'Структура себестоимости', rows: g.costStructure.map((x) => [x.kind === 'other' ? 'Прочее' : x.kind, fmtMetric({ state: 'ok', value: x.amountKop, unit: 'kop' })]) });
  if (g.expensesByContractor?.length) out.push({ title: 'Расходы на ремонт по исполнителям', rows: g.expensesByContractor.map((x) => [x.contractorId ? 'Подрядчик' : 'Без исполнителя', fmtMetric({ state: 'ok', value: x.amountKop, unit: 'kop' })]) });
  return out;
}

function prevText(m: Metric): string {
  if (m.state !== 'ok') return '–';
  if (m.prev === null || m.prev === undefined) return 'нет сравнения';
  return fmtMetric({ ...m, value: m.prev });
}
