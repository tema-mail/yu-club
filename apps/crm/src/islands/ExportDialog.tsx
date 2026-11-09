// Окно экспорта отчёта (S4-93; 14 §16, K24 §7–8, K11 №243): формат XLSX или CSV, состав – итоговые показатели или записи
// выбранного показателя. Фильтры берутся из адреса экрана в момент нажатия: файл совпадает с тем, что на экране (K24 §7).
// Без reports.export кнопки нет (решает страница). Без export.pd – предупреждение «телефоны будут скрыты»; детальные финансы –
// только с reports.export.detail; суммы зарплаты в файле – только с reports.export.payroll. Один ключ на попытку: двойной клик – одна задача.
import { useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { metricTitle, reportError, type ExportJob } from '../lib/reports.ts';

export interface ExportDialogProps {
  report: string;
  title: string;
  rights: { detail: boolean; pd: boolean; payroll: boolean };
  /** Отчёты, где записи – детальные финансы (K24 §8). */
  financeDetail: boolean;
}

const PARAMS = ['from', 'to', 'cityId', 'branchIds', 'resourceType', 'status', 'method'] as const;

export default function ExportDialog({ report, title, rights, financeDetail }: ExportDialogProps) {
  const dlg = useRef<HTMLDialogElement>(null);
  const key = useRef('');
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [detail, setDetail] = useState(false);
  const [metric, setMetric] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<ExportJob | null>(null);

  const openDialog = () => {
    const m = new URL(location.href).searchParams.get('metric') ?? '';
    setMetric(m);
    setDetail(false);
    setError('');
    setJob(null);
    key.current = crypto.randomUUID();
    dlg.current?.showModal();
  };
  const detailAllowed = metric !== '' && (!financeDetail || rights.detail);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const q = new URL(location.href).searchParams;
    const params: Record<string, string> = {};
    for (const k of PARAMS) if (q.get(k)) params[k] = q.get(k)!;
    if (detail) params.metric = metric;
    try {
      setJob(await browserCall<ExportJob>('/reports/exports', { method: 'POST', body: { report, format, detail, params }, key: key.current }));
    } catch (err) {
      setError(reportError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button class="yc-btn yc-btn--ghost" type="button" data-testid="export-open" onClick={openDialog}>Сформировать файл</button>
      <dialog ref={dlg} class="yc-dialog" aria-labelledby="export-h" data-testid="export-dialog">
        <form class="yc-dialog__body" method="dialog" onSubmit={submit}>
          <h2 id="export-h">Файл отчёта «{title}»</h2>
          {job ? (
            <div role="status" data-testid="export-queued">
              <p>Задача поставлена: файл формируется в фоне. Готовый файл хранится 24 часа.</p>
              <p><a href="/reports/exports">Мои файлы</a></p>
            </div>
          ) : (
            <>
              <fieldset class="yc-field" style="border:0;padding:0;margin:0">
                <legend class="yc-field__label">Формат</legend>
                <label class="yc-check"><input type="radio" name="format" value="xlsx" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} /> XLSX – для анализа в таблице</label>
                <label class="yc-check"><input type="radio" name="format" value="csv" checked={format === 'csv'} onChange={() => setFormat('csv')} /> CSV – для загрузки в другую программу</label>
              </fieldset>
              <fieldset class="yc-field" style="border:0;padding:0;margin:0">
                <legend class="yc-field__label">Состав</legend>
                <label class="yc-check"><input type="radio" name="detail" checked={!detail} onChange={() => setDetail(false)} /> Итоговые показатели</label>
                <label class="yc-check"><input type="radio" name="detail" checked={detail} disabled={!detailAllowed} onChange={() => setDetail(true)} />
                  {metric ? `Записи показателя «${metricTitle(metric)}»` : 'Записи показателя – сначала выберите карточку на экране'}</label>
                {metric && financeDetail && !rights.detail && <span class="yc-field__hint">Записи финансов в файл – только с отдельным правом.</span>}
              </fieldset>
              <p class="yc-field__hint">В файл попадут те же период и фильтры, что сейчас на экране.</p>
              {!rights.pd && <p class="yc-alert" data-testid="export-masked">Телефоны и фамилии клиентов будут скрыты: выгрузка персональных данных – только у Владельца.</p>}
              {report === 'staff' && !rights.payroll && <p class="yc-alert" data-testid="export-payroll">Суммы зарплаты в файл не попадут – для них нужно отдельное право.</p>}
              {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
            </>
          )}
          <div class="yc-dialog__actions">
            {!job && <button class="yc-btn" type="submit" disabled={busy}>{busy ? 'Ставим в очередь…' : 'Сформировать'}</button>}
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => dlg.current?.close()}>{job ? 'Готово' : 'Отмена'}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
