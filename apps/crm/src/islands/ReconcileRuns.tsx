// Ночная сверка (S4-96; K11 №248, 16 §14, reconcile.ts): запуски – когда, по расписанию или вручную, итог словами, сколько проверено;
// расхождения – что проверялось, «должно быть» и «хранится», переход в объект. Владелец видит всю сеть, число расхождений и текст сбоя;
// Директору сервер отдаёт расхождения только его зоны и без сетевых объектов (у них нет филиала). Экран – только при audit.view.
import { useEffect, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { fmtAt, fmtDate, fmtValue, reportError, type ReconcileDiscrepancy, type ReconcileRun } from '../lib/reports.ts';

export interface ReconcileRunsProps { timezone: string; branchNames: Record<string, string> }

const CHECK: Record<string, string> = {
  ledger_balance: 'Остаток счёта журнала', loyalty_points: 'Баллы клиента', loyalty_batch: 'Пачка баллов', certificate_balance: 'Остаток сертификата',
  cash_place: 'Остаток места денег', payroll_accrual: 'Начисление за смену', payroll_balance: 'Баланс зарплаты сотрудника', event_expense: 'Расходы мероприятия',
  repair_expense: 'Расходы ремонта', operation_link: 'Связь операции кассы',
};
const STATUS: Record<ReconcileRun['status'], string> = { running: 'Идёт', ok: 'Расхождений нет', discrepancies: 'Есть расхождения', failed: 'Не завершилась' };
/** Деньги – в копейках, баллы – в сотых, остальное – штуки. */
const UNIT: Record<string, 'kop' | 'centi' | 'count'> = { loyalty_points: 'centi', loyalty_batch: 'centi', operation_link: 'count' };

function objectHref(d: ReconcileDiscrepancy): string | null {
  const id = encodeURIComponent(d.objectId);
  const branch = d.branchId ? `/finance/${encodeURIComponent(d.branchId)}` : null;
  switch (d.objectType) {
    case 'client': return `/clients/${id}`;
    case 'loyalty_batch': return typeof d.details.clientId === 'string' ? `/clients/${encodeURIComponent(d.details.clientId)}` : null;
    case 'certificate': return `/certificates/${id}`;
    case 'shift': return `/shifts/${id}`;
    case 'staff': return `/staff/${id}`;
    case 'event': return `/events/${id}`;
    case 'repair': return `/repairs/${id}`;
    default: return branch; // branch, ledger_account, finance_operation – касса филиала
  }
}

export default function ReconcileRuns({ timezone, branchNames }: ReconcileRunsProps) {
  const [runs, setRuns] = useState<ReconcileRun[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = async (after: string | null) => {
    try {
      const r = await browserCall<{ items: ReconcileRun[]; nextCursor: string | null }>(`/reports/reconcile/runs${after ? `?cursor=${encodeURIComponent(after)}` : ''}`);
      setRuns((prev) => (after && prev ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(reportError(e));
    }
  };
  useEffect(() => { void load(null); }, []);

  if (error) return <p class="yc-alert yc-alert--error" role="alert">{error}</p>;
  if (!runs) return <p class="yc-empty" role="status">Загружаем журнал сверки…</p>;
  if (runs.length === 0) return <p class="yc-empty">Сверка ещё не запускалась.</p>;
  return (
    <div style="display:grid;gap:var(--yc-sp-s);min-width:0" data-testid="reconcile">
      {runs.map((r) => {
        const checked = r.checked ? Object.values(r.checked).reduce((a, b) => a + b, 0) : null;
        return (
          <section key={r.id} class="yc-panel" aria-label={`Сверка ${fmtAt(r.startedAt, timezone)}`} data-testid={`run-${r.id}`} style="display:grid;gap:var(--yc-sp-2xs);min-width:0">
            <h2 style="margin:0;font-size:var(--yc-fs-l)">
              {r.scheduledFor ? `Ночь на ${fmtDate(r.scheduledFor)}` : 'Ручной запуск'} · <span data-testid="run-status">{STATUS[r.status]}</span>
            </h2>
            <p style="margin:0;font-size:var(--yc-fs-xs);color:var(--yc-muted)">
              Начало {fmtAt(r.startedAt, timezone)}{r.finishedAt ? `, конец ${fmtAt(r.finishedAt, timezone)}` : ''} · {r.trigger === 'schedule' ? 'по расписанию' : 'вручную'}
              {checked !== null ? ` · проверено записей: ${checked}` : ''}
              {r.discrepancyCount !== undefined ? ` · расхождений по сети: ${r.discrepancyCount}` : ''}
            </p>
            {r.error && <p class="yc-alert yc-alert--error" style="margin:0">Сбой: {r.error}</p>}
            {r.discrepancies.length > 0 ? (
              <div class="rp-scroll">
                <table class="rp-table" data-testid="discrepancies">
                  <thead><tr><th scope="col">Проверка</th><th scope="col">Филиал</th><th scope="col">Должно быть</th><th scope="col">Хранится</th><th scope="col">Разница</th><th scope="col">Объект</th></tr></thead>
                  <tbody>
                    {r.discrepancies.map((d) => {
                      const unit = UNIT[d.check] ?? 'kop';
                      const href = objectHref(d);
                      return (
                        <tr key={`${d.check}${d.objectId}`}>
                          <th scope="row">{CHECK[d.check] ?? d.check}</th>
                          <td>{d.branchId ? (branchNames[d.branchId] ?? 'Филиал') : 'Вся сеть'}</td>
                          <td>{fmtValue(d.expected, unit)}</td>
                          <td>{fmtValue(d.actual, unit)}</td>
                          <td>{fmtValue(d.actual - d.expected, unit)}</td>
                          <td>{href ? <a href={href}>Открыть</a> : '–'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : r.status === 'discrepancies' ? <p class="yc-empty" style="margin:0">В вашей зоне расхождений нет.</p> : null}
          </section>
        );
      })}
      {cursor && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void load(cursor)}>Показать ещё</button>}
    </div>
  );
}
