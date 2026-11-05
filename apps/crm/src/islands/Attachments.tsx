// Вложения оборудования и ремонта (S3-78, K19 №350, §9; 10 §11): загрузка телом запроса, список версий, «недействителен» с причиной.
// Файл не заменяется: новая версия – новая строка с supersedes. Лимит и типы проверяются до отправки (Q-96: JPG, PNG, PDF до 10 МБ) и
// окончательно на сервере (ATTACHMENT_TOO_LARGE, ATTACHMENT_TYPE_NOT_ALLOWED). Скачивание – только через API с правом на объект.
// Право записи – repair.attach; у списанного оборудования документы разрешены (K19 §15).
import { useEffect, useRef, useState } from 'preact/hooks';
import { API_PREFIX, ApiError, browserCall } from '../lib/api.ts';
import { DOC_TYPE, errorText, fmtAt, type AttachmentDto } from '../lib/equipment.ts';

export interface AttachmentsProps {
  ownerType: 'equipment' | 'repair';
  ownerId: string;
  timezone: string;
  canAttach: boolean;
}
const MAX_BYTES = 10_485_760;
const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1).replace('.', ',')} МБ`;

/** Загрузка: тело – сам файл, Content-Type – его тип; параметры – в адресе (№350). */
async function upload(file: File, q: URLSearchParams): Promise<{ attachmentId: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}/attachments?${q}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'idempotency-key': crypto.randomUUID(), accept: 'application/json' }, credentials: 'same-origin', body: file });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите.');
  }
  if (res.status === 413) {
    const b = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new ApiError(413, b?.error?.code ?? 'ATTACHMENT_TOO_LARGE', `Файл больше допустимого размера (${mb(MAX_BYTES)}) – сервер его не принял.`);
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    throw new ApiError(res.status, b?.error?.code ?? 'INTERNAL', b?.error?.message ?? 'Не удалось загрузить файл.', b?.error?.details);
  }
  return (await res.json()) as { attachmentId: string };
}

export default function Attachments(p: AttachmentsProps) {
  const [items, setItems] = useState<AttachmentDto[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState('photo');
  const [comment, setComment] = useState('');
  const [versionOf, setVersionOf] = useState<AttachmentDto | null>(null);
  const [invalid, setInvalid] = useState<AttachmentDto | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const load = async () => {
    try {
      setItems((await browserCall<{ items: AttachmentDto[] }>(`/attachments?ownerType=${p.ownerType}&ownerId=${p.ownerId}`)).items);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, [p.ownerId]);

  const superseded = new Set((items ?? []).map((a) => a.supersedes).filter(Boolean));
  const localCheck = (f: File): string => {
    if (f.size > MAX_BYTES) return `Файл ${mb(f.size)} – больше лимита ${mb(MAX_BYTES)}. Уменьшите его и повторите.`;
    if (!TYPES.includes(f.type)) return 'Можно приложить только JPG, PNG или PDF.';
    return '';
  };
  const pick = (e: Event) => {
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
    setNotice('');
    setError(f ? localCheck(f) : '');
    setFile(f && !localCheck(f) ? f : null);
  };
  const reset = () => {
    setFile(null);
    setComment('');
    setVersionOf(null);
    if (fileInput.current) fileInput.current.value = '';
  };
  const send = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!file) return setError((prev) => prev || 'Выберите файл.');
    setBusy(true);
    setError('');
    const q = new URLSearchParams({ ownerType: p.ownerType, ownerId: p.ownerId, docType, name: file.name });
    if (comment.trim()) q.set('comment', comment.trim());
    if (versionOf) q.set('supersedes', versionOf.id);
    try {
      await upload(file, q);
      setNotice(versionOf ? 'Новая версия загружена, прежняя осталась в списке.' : 'Файл загружен.');
      reset();
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const submitInvalid = async (e: Event) => {
    e.preventDefault();
    if (busy || !invalid) return;
    if (!reason.trim()) return setError('Укажите причину.');
    setBusy(true);
    setError('');
    try {
      await browserCall(`/attachments/${invalid.id}/invalidate`, { method: 'POST', body: { reason: reason.trim() } });
      dialog.current?.close();
      setNotice('Документ отмечен недействительным: файл и запись сохранены.');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="yc-panel" role="tabpanel" aria-label="Документы и фотографии">
      <h2>Документы и фотографии</h2>
      {notice && <p class="yc-alert yc-alert--ok" role="status" data-testid="att-notice">{notice}</p>}
      {p.canAttach && (
        <form class="yc-form yc-form--wide" novalidate onSubmit={send} data-testid="att-form">
          {versionOf && <p class="yc-eq__warn" data-testid="att-version-of">Новая версия файла «{versionOf.originalName ?? DOC_TYPE[versionOf.docType]}». Прежний файл не заменяется и останется в списке. <button type="button" class="yc-btn yc-btn--ghost" onClick={reset}>Не загружать версию</button></p>}
          <label class="yc-field"><span class="yc-field__label">Файл (JPG, PNG, PDF, до 10 МБ)</span>
            <input ref={fileInput} class="yc-input" type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" onChange={pick} />
          </label>
          <div class="yc-eq__pair">
            <label class="yc-field"><span class="yc-field__label">Тип документа</span>
              <select class="yc-input" value={docType} onChange={(e) => setDocType((e.currentTarget as HTMLSelectElement).value)}>
                {Object.entries(DOC_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label class="yc-field"><span class="yc-field__label">Комментарий</span>
              <input class="yc-input" maxLength={2000} value={comment} onInput={(e) => setComment((e.currentTarget as HTMLInputElement).value)} />
            </label>
          </div>
          <p class="yc-alert yc-alert--error" role="alert" data-testid="att-error">{error}</p>
          <div class="yc-eq__actions"><button type="submit" class="yc-btn" disabled={busy}>Загрузить</button></div>
        </form>
      )}
      {!p.canAttach && error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
      {items?.length === 0 && <p class="yc-empty">Документов пока нет.</p>}
      <ul class="yc-eq__rows" data-testid="att-list">
        {items?.map((a) => (
          <li class="yc-eq__row" key={a.id} data-testid="att-row">
            <a href={`${API_PREFIX}/attachments/${a.id}`} download={a.originalName ?? undefined}><strong>{a.originalName ?? DOC_TYPE[a.docType]}</strong></a>
            <span class="yc-eq__muted">
              {DOC_TYPE[a.docType] ?? a.docType} · {mb(a.sizeBytes)} · {fmtAt(a.createdAt, p.timezone)}
              {a.supersedes ? ' · новая версия' : ''}{superseded.has(a.id) ? ' · есть новая версия' : ''}
            </span>
            {a.comment && <span>{a.comment}</span>}
            {a.status === 'invalid' && <span class="yc-badge yc-badge--temporarily_closed">Недействителен{a.invalidReason ? `: ${a.invalidReason}` : ''}</span>}
            {p.canAttach && a.status === 'active' && (
              <span class="yc-eq__actions">
                {!superseded.has(a.id) && <button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setVersionOf(a); setDocType(a.docType); setNotice(''); fileInput.current?.focus(); }}>Загрузить новую версию</button>}
                <button type="button" class="yc-btn yc-btn--ghost" onClick={() => { setInvalid(a); setReason(''); setError(''); dialog.current?.showModal(); }}>Недействителен…</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="att-title" onClose={() => setInvalid(null)}>
        <form class="yc-dialog__body" novalidate onSubmit={submitInvalid}>
          <h2 id="att-title">Отметить документ недействительным?</h2>
          <p class="yc-field__hint">Документы не удаляются: файл и запись останутся в списке с отметкой и причиной.</p>
          <label class="yc-field"><span class="yc-field__label">Причина *</span>
            <textarea class="yc-input" rows={2} maxLength={2000} value={reason} onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)} />
          </label>
          <p class="yc-alert yc-alert--error" role="alert">{error}</p>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Не менять</button>
            <button type="submit" class="yc-btn" disabled={busy}>Отметить</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
