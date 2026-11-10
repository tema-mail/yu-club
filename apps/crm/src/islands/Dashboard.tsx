// Рабочий стол руководителя (S4-94; 13 §6.2–6.4, K24 §4, K11 №239): карточки сводного дашборда – каждая число своего отчёта и
// ссылка в этот отчёт с тем же периодом и областью. Набор карточек решает сервер по правам: Директору – его зона, Администратору
// денег не приходит. Поступления, возвраты, расходы, движение и остаток – отдельными карточками, «прибыли» нет.
// У Владельца – предупреждения: расхождения последней ночной сверки, брони, ожидающие решения, не дошедшие критичные уведомления (K21 §9).
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fmtAt, fmtDate, fmtDelta, fmtMetric, fmtPeriod, presets, reportError, reportHref, todayIn,
  type DashboardCard, type DashboardResult, type Metric, type Period, type ReconcileRun, type ReportResult,
} from '../lib/reports.ts';
import { getJson, getReport } from './ReportView.tsx';
import type { FailuresSummary } from '../lib/notifications.ts';

export interface DashboardProps {
  /** Область контекста шапки: город или вся зона. */
  cityId: string;
  timezone: string;
  /** Владелец: предупреждения о сверке и решениях. */
  warnings: boolean;
}

const GROUPS: Array<{ title: string; keys: string[] }> = [
  { title: 'Брони и загрузка', keys: ['created', 'visited', 'cancelledByClient', 'cancelledByClub', 'noShows', 'actualLoad'] },
  { title: 'Деньги', keys: ['incomeSession', 'incomeEvent', 'incomeCertificateSale', 'refunds', 'expenses', 'netMovement', 'cashClosing'] },
  { title: 'Мероприятия', keys: ['eventsCount'] },
  { title: 'Смены сотрудников', keys: ['emptyIntervals', 'unclosedShifts'] },
  { title: 'Оборудование', keys: ['openFaults', 'downtime'] },
];
const PERIODS = [['today', 'Сегодня'], ['week', 'Эта неделя'], ['month', 'Этот месяц']] as const;

interface Warning { key: string; text: string; href: string }

export default function Dashboard({ cityId, timezone, warnings }: DashboardProps) {
  const all = presets(todayIn(timezone));
  const [periodKey, setPeriodKey] = useState<string>('week');
  const [data, setData] = useState<DashboardResult | null>(null);
  const [warns, setWarns] = useState<Warning[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(''); // ожидание автоповтора при 503 REPORT_BUSY (D5-10)
  const ctrl = useRef<AbortController | null>(null);
  const period: Period = all.find((p) => p.key === periodKey)!.period;

  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setData(null);
    setError('');
    setNotice('');
    const q = new URLSearchParams({ from: period.from, to: period.to });
    if (cityId) q.set('cityId', cityId);
    getReport<DashboardResult>(`/reports/dashboard?${q}`, c.signal, (n) => !c.signal.aborted && setNotice(n)).then(setData).catch((e: unknown) => {
      if ((e as Error).name !== 'AbortError') setError(reportError(e));
    });
    if (warnings) void loadWarnings(q, timezone, c.signal).then((w) => { if (!c.signal.aborted) setWarns(w); });
    return () => c.abort();
  }, [periodKey]);

  const link = (c: DashboardCard) => reportHref(c.link.report, { from: period.from, to: period.to, cityId, metric: c.link.metric });
  const byKey = new Map((data?.cards ?? []).map((c) => [c.key, c]));

  return (
    <section class="rp-desk" aria-labelledby="desk-h" data-testid="dashboard" style="display:grid;gap:var(--yc-sp-s);min-width:0">
      <div style="display:flex;flex-wrap:wrap;gap:var(--yc-sp-xs);align-items:center;justify-content:space-between">
        <h2 id="desk-h" style="margin:0">Рабочий стол</h2>
        <div class="yc-seg" role="group" aria-label="Период рабочего стола">
          {PERIODS.map(([k, label]) => (
            <button key={k} type="button" class="yc-seg__btn" aria-pressed={periodKey === k} onClick={() => setPeriodKey(k)}>{label}</button>
          ))}
        </div>
      </div>
      {warns.length > 0 && (
        <ul class="yc-alert" role="alert" data-testid="desk-warnings" style="margin:0;padding-left:1.5rem">
          {warns.map((w) => <li key={w.key}><a href={w.href}>{w.text}</a></li>)}
        </ul>
      )}
      {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      {!data && !error && <p class="yc-empty" role="status">{notice || 'Считаем показатели…'}</p>}
      {data && (
        <>
          <p style="margin:0;font-size:var(--yc-fs-xs);color:var(--yc-muted)">
            {fmtPeriod(data.period)} · сравнение с {fmtPeriod(data.prevPeriod)} · рассчитано {fmtAt(data.computedAt, timezone)} · {data.dayRule}
          </p>
          {GROUPS.map((g) => {
            const cards = g.keys.map((k) => byKey.get(k)).filter((c): c is DashboardCard => c !== undefined);
            if (cards.length === 0) return null;
            return (
              <div key={g.title} style="display:grid;gap:var(--yc-sp-2xs)" data-testid={`desk-${g.title}`}>
                <h3 style="margin:0;font-size:var(--yc-fs-m)">{g.title}</h3>
                <ul class="rp-cards">
                  {cards.map((c) => (
                    <li key={c.key}>
                      <a class={`rp-card${c.metric.state !== 'ok' ? ' rp-card--muted' : ''}`} href={link(c)} data-testid={`desk-card-${c.key}`} style="text-decoration:none">
                        <span class="rp-card__title">{c.title}</span>
                        <span class="rp-card__value">{fmtMetric(c.metric)}</span>
                        <span class="rp-card__delta">к прошлому периоду: {fmtDelta(c.metric)}</span>
                        {c.note && <span class="rp-card__basis">{c.note}</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {data.cards.length === 0 && <p class="yc-empty">Для вашей роли показателей рабочего стола нет.</p>}
          <p style="margin:0"><a href="/reports">Все отчёты</a></p>
        </>
      )}
    </section>
  );
}

/** Предупреждения Владельца (K24 §4): расхождения последней сверки, брони, ожидающие решения. Ошибка – без предупреждения, стол работает. */
async function loadWarnings(q: URLSearchParams, timezone: string, signal: AbortSignal): Promise<Warning[]> {
  const out: Warning[] = [];
  try {
    const runs = await getJson<{ items: ReconcileRun[] }>('/reports/reconcile/runs', signal);
    const last = runs.items[0];
    if (last?.status === 'discrepancies') {
      out.push({ key: 'reconcile', text: `Ночная сверка ${last.scheduledFor ? fmtDate(last.scheduledFor) : ''} нашла расхождения: ${last.discrepancyCount ?? last.discrepancies.length}`, href: '/reports/reconcile' });
    } else if (last?.status === 'failed') out.push({ key: 'reconcile', text: 'Последняя ночная сверка не завершилась', href: '/reports/reconcile' });
  } catch { /* предупреждение не обязательно */ }
  try {
    const b = await getJson<ReportResult>(`/reports/bookings?${q}`, signal);
    const m: Metric | undefined = b.metrics.awaitingDecision;
    if (m?.state === 'ok' && m.value > 0) out.push({ key: 'decide', text: `Брони ждут решения: ${m.value}`, href: reportHref('bookings', { from: q.get('from')!, to: q.get('to')!, metric: 'awaitingDecision' }) });
  } catch { /* то же */ }
  try {
    // K21 §9: критичные сервисные уведомления, которые не дошли клиенту, за период сервера – ведёт в журнал отправок с ошибкой
    // форма – №251 (K11, notifications/journal.ts FailuresSummary): период [to − days, to) в ISO; журнал принимает дни – по зоне сети
    const f = await getJson<FailuresSummary>('/notifications/failures/summary', signal);
    if (f.critical > 0) {
      const from = todayIn(timezone, new Date(f.period.from));
      const to = todayIn(timezone, new Date(f.period.to));
      const p = new URLSearchParams({ tab: 'rows', category: 'service', status: 'error', from, to });
      out.push({ key: 'failures', text: `Критичные уведомления не дошли: ${f.critical} (${fmtPeriod({ from, to })})`, href: `/notifications?${p}` });
    }
  } catch { /* то же */ }
  return out;
}
