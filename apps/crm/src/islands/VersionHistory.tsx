// S4-88: история версий (K22 §3; 12 §9.5; K11 №218): кто, когда, причина; сравнение двух версий или версии с черновиком по полям;
// откат с обязательной причиной – новая версия с тем же снимком (история линейна, старые не меняются). rowVersion берём свежим прямо
// перед откатом; после отката страница перезагружается – форма редактора получает новый черновик.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { aria, errorText, Field, FIELD_LABEL, fieldErrors, fmtAt, type DraftDto, type VersionDto } from '../lib/content.tsx';

export interface VersionHistoryProps {
  /** GET списка версий. */
  versionsPath: string;
  /** GET текущего черновика (rowVersion и поля для сравнения). */
  draftPath: string;
  /** POST {actionBase}/rollback{query}. */
  actionBase: string;
  query?: string;
  canRollback: boolean;
  timezone: string;
}

const DRAFT = 'draft';
function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '–';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  return String(v);
}

export default function VersionHistory(props: VersionHistoryProps) {
  const [items, setItems] = useState<VersionDto[] | null>(null);
  const [draft, setDraft] = useState<DraftDto | null>(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState('');
  const [right, setRight] = useState(DRAFT);
  const [target, setTarget] = useState<VersionDto | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    Promise.all([browserCall<{ items: VersionDto[] }>(props.versionsPath), browserCall<DraftDto>(props.draftPath)])
      .then(([v, d]) => {
        setItems(v.items);
        setDraft(d);
        setLeft(v.items[0]?.id ?? '');
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  const snap = (id: string): Record<string, unknown> | null => (id === DRAFT ? (draft?.draft ?? null) : (items?.find((v) => v.id === id)?.snapshot ?? null));
  const name = (id: string) => (id === DRAFT ? 'Черновик' : `Версия ${items?.find((v) => v.id === id)?.versionNo ?? ''}`);
  const a = snap(left);
  const b = snap(right);
  const keys = a && b ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'media').sort((x, y) => (FIELD_LABEL[x] ?? x).localeCompare(FIELD_LABEL[y] ?? y)) : [];

  const ask = (v: VersionDto) => {
    setTarget(v);
    setReason('');
    setReasonError('');
    dialog.current?.showModal();
  };
  const rollback = async () => {
    if (!target) return;
    if (!reason.trim()) return setReasonError('Укажите причину отката');
    setBusy(true);
    try {
      const fresh = await browserCall<DraftDto>(props.draftPath);
      const r = await browserCall<{ versionNo: number }>(`${props.actionBase}/rollback${props.query ?? ''}`, { method: 'POST', body: { versionId: target.id, rowVersion: fresh.rowVersion, reason: reason.trim() } });
      dialog.current?.close();
      setMsg({ ok: true, text: `Откат выполнен: опубликована версия ${r.versionNo} с содержимым версии ${target.versionNo}.` });
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      const fe = fieldErrors(e);
      if (fe.reason) setReasonError(fe.reason);
      else {
        dialog.current?.close();
        setMsg({ ok: false, text: `Откат не выполнен: ${fe._ ?? errorText(e)}` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="yc-ct__box" aria-labelledby="ver-title" data-testid="versions">
      <h2 id="ver-title">История версий</h2>
      {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      {items && items.length === 0 && <p class="yc-ct__muted">Версий ещё нет: они появляются при публикации.</p>}
      <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
      {items && items.length > 0 && (
        <>
          <ol class="yc-ct__versions" data-testid="version-list">
            {items.map((v) => (
              <li data-testid={`version-${v.versionNo}`}>
                <strong>Версия {v.versionNo}{v.id === draft?.liveVersionId && draft?.status === 'published' ? ' – на сайте' : ''}</strong>
                <span class="yc-ct__muted">{fmtAt(v.publishedAt, props.timezone)}, {v.publishedByName ?? 'сотрудник'}{v.action === 'rollback_publish' ? `; откат к версии ${items.find((x) => x.id === v.sourceVersionId)?.versionNo ?? '?'}` : ''}</span>
                {v.reason && <span>Причина: {v.reason}</span>}
                {props.canRollback && v.id !== draft?.liveVersionId && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => ask(v)}>Откатить к этой версии…</button>}
              </li>
            ))}
          </ol>
          <div class="yc-ct__filters">
            <label class="yc-field"><span class="yc-field__label">Сравнить</span>
              <select class="yc-input" aria-label="Сравнить версию" value={left} onChange={(e) => setLeft(e.currentTarget.value)}>{items.map((v) => <option value={v.id}>Версия {v.versionNo}</option>)}</select>
            </label>
            <label class="yc-field"><span class="yc-field__label">С</span>
              <select class="yc-input" aria-label="С версией или черновиком" value={right} onChange={(e) => setRight(e.currentTarget.value)}><option value={DRAFT}>Черновик</option>{items.map((v) => <option value={v.id}>Версия {v.versionNo}</option>)}</select>
            </label>
          </div>
          <table class="yc-ct__diff" data-testid="version-diff">
            <thead><tr><th>Поле</th><th>{name(left)}</th><th>{name(right)}</th></tr></thead>
            <tbody>
              {keys.map((k) => {
                const changed = JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]);
                return <tr data-changed={changed ? 'true' : undefined} data-field={k}><td>{FIELD_LABEL[k] ?? k}{changed ? ' *' : ''}</td><td>{show(a?.[k])}</td><td>{show(b?.[k])}</td></tr>;
              })}
            </tbody>
          </table>
          <p class="yc-ct__muted">* – поле отличается.</p>
        </>
      )}
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="ver-dlg">
        <div class="yc-dialog__body">
          <h2 id="ver-dlg">Откатить к версии {target?.versionNo}?</h2>
          <p>На сайте сразу появится содержимое этой версии – новой версией в истории. Черновик заменится им: несохранённые правки в форме пропадут.</p>
          <Field id="ver-reason" label="Причина" error={reasonError}>
            <textarea class="yc-input" {...aria('ver-reason', reasonError)} rows={3} maxLength={2000} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
          </Field>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Отмена</button>
            <button type="button" class="yc-btn yc-btn--danger" disabled={busy} onClick={() => void rollback()}>Откатить</button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
