// S4-88: предпросмотр черновика (K22 §11; 12 §9.3). Кнопка берёт токен (K11 №233) и открывает /content/preview/{token} – страницу CRM,
// которая сама получает HTML у сайта по внутренней сети и рисует его здесь же, в PreviewFrames: <iframe srcdoc sandbox=""> 390 и 1440 px.
// sandbox пустой – БЕЗ allow-same-origin и БЕЗ allow-scripts: черновик не исполняется, не видит куку CRM и не ходит в её API.
// Публичный адрес черновика не открывается: токен живёт 10 минут и без секрета CRM сайту бесполезен.
import { useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { errorText, type BranchRef, type EntityType } from '../lib/content.tsx';

export const PREVIEW_WIDTHS = [
  { width: 390, label: 'Телефон, 390 px' },
  { width: 1440, label: 'Компьютер, 1440 px' },
] as const;

/** Кадры предпросмотра: только SSR (без client:*), атрибут sandbox – пустая строка. */
export function PreviewFrames({ html }: { html: string }) {
  return (
    <div class="yc-ct__frames">
      {PREVIEW_WIDTHS.map(({ width, label }) => (
        <section aria-label={label}>
          <h2>{label}</h2>
          <div class="yc-ct__frame">
            <iframe title={`Черновик: ${label}`} srcdoc={html} sandbox="" width={width} height={800} style={{ width: `${width}px` }} />
          </div>
        </section>
      ))}
    </div>
  );
}

export default function PreviewFrame(props: { entityType: EntityType; id: string | null; branches: BranchRef[] }) {
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const open = async () => {
    if (!props.id) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await browserCall<{ previewPath: string }>(`/content/${props.entityType}/${props.id}/preview-token`, { method: 'POST', body: branchId ? { branchId } : {} });
      const w = window.open(r.previewPath, '_blank');
      if (!w) setMsg('Браузер не открыл окно – разрешите всплывающие окна для CRM.');
    } catch (e) {
      setMsg(`Предпросмотр недоступен: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="yc-ct__box" aria-labelledby="pv-title">
      <h2 id="pv-title">Предпросмотр</h2>
      {props.id ? (
        <>
          <p class="yc-ct__muted">Показывает сохранённый черновик в ширине телефона и компьютера. На сайте его нет.</p>
          {props.branches.length > 1 && (
            <label class="yc-field"><span class="yc-field__label">Как в филиале</span>
              <select class="yc-input" value={branchId} onChange={(e) => setBranchId(e.currentTarget.value)}><option value="">Без филиала</option>{props.branches.map((b) => <option value={b.id}>{b.name}</option>)}</select>
            </label>
          )}
          <button type="button" class="yc-btn yc-btn--ghost" disabled={busy} onClick={() => void open()}>Открыть предпросмотр</button>
          {msg && <p class="yc-alert yc-alert--error" role="alert">{msg}</p>}
        </>
      ) : <p class="yc-ct__muted">Сохраните черновик – после этого появится предпросмотр.</p>}
    </section>
  );
}
