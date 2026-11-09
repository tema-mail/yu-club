// Мои файлы отчётов (S4-93; K24 §7, K11 №244–247): свои задачи экспорта, новые сверху, со статусами словами. Готовый – ссылка на
// скачивание (attachment, файл не открывается как страница); срок хранения истёк – без ссылки, с советом сформировать заново;
// ошибка – причина словами; в очереди и формируется – отмена. Пока есть идущие задачи, список обновляется сам.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { fmtAt, fmtPeriod, metricTitle, reportError, reportInfo, type ExportJob, type ExportStatus } from '../lib/reports.ts';

export interface ExportJobsProps { timezone: string }

const STATUS: Record<ExportStatus, string> = { queued: 'В очереди', running: 'Формируется', ready: 'Готов', expired: 'Срок хранения истёк', failed: 'Ошибка', cancelled: 'Отменён' };
const ERRORS: Record<string, string> = {
  EXPORT_TOO_LARGE: 'больше 200 000 строк – сузьте период',
  EXPORT_FORBIDDEN: 'право на этот файл потеряно',
  EXPORT_INTERRUPTED: 'расчёт прервался – сформируйте заново',
  REPORT_TIMEOUT: 'расчёт не уложился по времени – сузьте период',
};
const POLL_MS = 2000;

export default function ExportJobs({ timezone }: ExportJobsProps) {
  const [items, setItems] = useState<ExportJob[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try {
      const r = await browserCall<{ items: ExportJob[]; nextCursor: string | null }>('/reports/exports');
      setItems(r.items);
      setState('ready');
      if (timer.current) clearTimeout(timer.current);
      if (r.items.some((j) => j.status === 'queued' || j.status === 'running')) timer.current = setTimeout(() => void load(), POLL_MS);
    } catch (e) {
      setError(reportError(e));
      setState('error');
    }
  };
  useEffect(() => {
    void load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const cancel = async (j: ExportJob) => {
    setNotice('');
    try {
      const r = await browserCall<ExportJob>(`/reports/exports/${encodeURIComponent(j.id)}/cancel`, { method: 'POST' });
      setItems((prev) => prev.map((x) => (x.id === r.id ? r : x)));
      setNotice(r.status === 'cancelled' ? 'Задача отменена.' : 'Задача уже завершилась – отменять нечего.');
    } catch (e) {
      setNotice(reportError(e));
    }
  };

  if (state === 'loading') return <p class="yc-empty" role="status">Загружаем задачи…</p>;
  if (state === 'error') return <p class="yc-alert yc-alert--error" role="alert">{error} <button class="yc-link" type="button" onClick={() => void load()}>Повторить</button></p>;
  return (
    <section class="yc-panel" aria-label="Мои файлы" data-testid="export-jobs">
      {notice && <p class="yc-alert" role="status">{notice}</p>}
      {items.length === 0 ? <p class="yc-empty">Файлов пока нет. Откройте отчёт и нажмите «Сформировать файл».</p> : (
        <table class="yc-table">
          <thead><tr><th scope="col">Отчёт</th><th scope="col">Период</th><th scope="col">Состав</th><th scope="col">Поставлен</th><th scope="col">Статус</th><th scope="col">Файл</th></tr></thead>
          <tbody>
            {items.map((j) => {
              const p = j.params as { from?: string; to?: string; metric?: string };
              return (
                <tr key={j.id} data-testid={`job-${j.id}`}>
                  <td class="yc-table__main">{reportInfo(j.report)?.title ?? (j.report === 'dashboard' ? 'Сводка' : j.report)}, {j.format.toUpperCase()}</td>
                  <td data-label="Период">{p.from && p.to ? fmtPeriod({ from: p.from, to: p.to }) : '–'}</td>
                  <td data-label="Состав">{j.detail ? `записи «${metricTitle(p.metric ?? '')}»` : 'итоги'}{j.masked ? ', телефоны скрыты' : ''}</td>
                  <td data-label="Поставлен">{fmtAt(j.createdAt, timezone)}</td>
                  <td data-label="Статус" data-testid="status">
                    {STATUS[j.status]}{j.status === 'failed' && j.errorCode ? `: ${ERRORS[j.errorCode] ?? j.errorCode}` : ''}
                    {j.status === 'ready' && j.expiresAt ? <span class="yc-field__hint" style="display:block">хранится до {fmtAt(j.expiresAt, timezone)}</span> : null}
                  </td>
                  <td data-label="Файл">
                    {j.status === 'ready' && <a class="yc-btn yc-btn--ghost" href={`/api/crm/v1/reports/exports/${encodeURIComponent(j.id)}/file`} download>Скачать{j.rows !== null ? ` (${j.rows} строк)` : ''}</a>}
                    {j.status === 'expired' && <span>Сформируйте заново</span>}
                    {(j.status === 'queued' || j.status === 'running') && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void cancel(j)}>Отменить</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
