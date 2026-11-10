// S4-85: медиатека (K22 §8, K11 №224–227; 12 §10): загрузка с понятной ошибкой («Можно JPG, PNG, WebP до 10 МБ»), рекомендуемые пропорции,
// alt и подпись (правка alt попадает на сайт только со следующей публикацией – снимок версии заморожен), «где используется», архив
// (используемый живой версией – MEDIA_IN_USE со списком), удаление неиспользуемого – только Владелец. Загрузка идёт через прокси CRM потоком.
import { useEffect, useRef, useState } from 'preact/hooks';
import { API_PREFIX, ApiError, browserCall, type ErrorBody } from '../lib/api.ts';
import { useLatest } from '../lib/latest.ts';
import { PURGE_REASON_CODES, PURGE_REASON_LABEL } from '../../../../packages/contracts/src/media-purge.ts';
import { aria, ENTITY_LABEL, errorText, Field, FIELD_LABEL, fmtAt, type MediaDto } from '../lib/content.tsx';

export const MAX_BYTES = 10 * 1024 * 1024;
export const TYPE_ERROR = 'Можно JPG, PNG, WebP до 10 МБ';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Рекомендуемые пропорции (12 §10): обложка и баннер главной режутся сайтом под 16:9, галерея – под 4:3. */
export const RATIO_HINT = {
  cover: 'Обложка: 16:9, не меньше 1600×900 px.',
  banner: 'Баннер главной: 16:9, не меньше 1920×1080 px; важное – в центре, края обрезаются на телефоне.',
  gallery: 'Галерея: 4:3, не меньше 1200×900 px.',
};
export const ALT_HINT = 'Изменение попадёт на сайт со следующей публикацией материала, где используется картинка.';

/** Загрузка (№224): multipart через прокси CRM; тип и размер проверяем до отправки, сервер проверит ещё раз по сигнатуре. */
export async function uploadMedia(file: File, purpose: 'image' | 'document', alt: string, title: string): Promise<{ media: MediaDto; duplicate: boolean }> {
  const allowed = purpose === 'document' ? ['application/pdf'] : IMAGE_TYPES;
  if (file.size > MAX_BYTES || !allowed.includes(file.type)) throw new ApiError(415, 'MEDIA_TYPE_NOT_ALLOWED', purpose === 'document' ? 'Можно PDF до 10 МБ' : TYPE_ERROR);
  const form = new FormData();
  form.set('purpose', purpose);
  if (alt.trim()) form.set('alt', alt.trim());
  if (title.trim()) form.set('title', title.trim());
  form.set('file', file);
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}/content/media`, { method: 'POST', headers: { accept: 'application/json', 'idempotency-key': crypto.randomUUID() }, credentials: 'same-origin', body: form });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен. Проверьте связь и повторите.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<ErrorBody>;
    const code = body.error?.code ?? 'INTERNAL';
    const text = code === 'MEDIA_TYPE_NOT_ALLOWED' || code === 'MEDIA_TOO_LARGE' ? TYPE_ERROR : (body.error?.message ?? 'Не загружено');
    throw new ApiError(res.status, code, text, body.error?.details);
  }
  return (await res.json()) as { media: MediaDto; duplicate: boolean };
}

export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`);
export function Thumb({ m }: { m: MediaDto }) {
  return <div class="yc-ct__thumb">{m.purpose === 'image' ? <img src={m.url} alt={m.alt ?? ''} loading="lazy" onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} /> : <span>PDF</span>}</div>;
}
type Usage = { entityType: string; entityId: string; field: string; live: boolean };
const usageHref = (u: Usage) => (u.entityType === 'publication' ? `/content/publications/${u.entityId}` : u.entityType === 'game' ? `/content/games/${u.entityId}` : null);
function UsageList({ items }: { items: Usage[] }) {
  return (
    <ul class="yc-ct__versions" data-testid="media-usages">
      {items.map((u) => {
        const href = usageHref(u);
        const label = `${ENTITY_LABEL[u.entityType] ?? u.entityType}: ${FIELD_LABEL[u.field.split('.')[0]!] ?? u.field} – ${u.live ? 'на сайте' : 'в черновике'}`;
        return <li>{href ? <a href={href}>{label}</a> : label}</li>;
      })}
    </ul>
  );
}


export interface MediaLibraryProps { canArchive: boolean; canDelete: boolean; timezone: string }

export default function MediaLibrary(props: MediaLibraryProps) {
  const [filter, setFilter] = useState({ q: '', type: '', archived: false });
  const [items, setItems] = useState<MediaDto[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [up, setUp] = useState({ purpose: 'image' as 'image' | 'document', alt: '', title: '' });
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [upMsg, setUpMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<MediaDto | null>(null);
  const [edit, setEdit] = useState({ alt: '', title: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [usages, setUsages] = useState<{ usages: Usage[]; inVersions: boolean } | null>(null);
  const purgeDlg = useRef<HTMLDialogElement>(null);
  const [purge, setPurge] = useState({ reasonCode: '', basis: '', confirmed: false, error: '', key: '' });

  const latest = useLatest(); // новый поиск или фильтр: ответ прежнего не подменяет список
  useEffect(() => {
    const fresh = latest();
    const p = new URLSearchParams({ limit: '100' });
    if (filter.q.trim()) p.set('q', filter.q.trim());
    if (filter.type) p.set('type', filter.type);
    if (filter.archived) p.set('archived', 'true');
    setLoadError('');
    browserCall<{ items: MediaDto[] }>(`/content/media?${p}`).then((r) => fresh() && setItems(r.items)).catch((e: unknown) => fresh() && setLoadError(errorText(e)));
  }, [reload]);

  const choose = (m: MediaDto) => {
    setSel(m);
    setEdit({ alt: m.alt ?? '', title: m.title ?? '' });
    setMsg(null);
    setUsages(null);
  };

  const upload = async (e: Event) => {
    e.preventDefault();
    setUpMsg(null);
    if (!file) return setUpMsg({ ok: false, text: 'Выберите файл.' });
    setBusy(true);
    try {
      const r = await uploadMedia(file, up.purpose, up.alt, up.title);
      setUpMsg({ ok: true, text: r.duplicate ? 'Такой файл уже есть в медиатеке – открыт он.' : 'Файл загружен.' });
      setUp({ ...up, alt: '', title: '' });
      setFile(null);
      setFileKey((n) => n + 1);
      choose(r.media);
      setReload((n) => n + 1);
    } catch (err) {
      setUpMsg({ ok: false, text: `${err instanceof ApiError ? err.message : errorText(err)}${file ? ` Файл «${file.name}» не загружен.` : ''}` });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!sel) return;
    setBusy(true);
    setMsg(null);
    try {
      const m = await browserCall<MediaDto>(`/content/media/${sel.id}`, { method: 'PATCH', body: { alt: edit.alt.trim() || null, title: edit.title.trim() || null, rowVersion: sel.rowVersion } });
      setSel(m);
      setMsg({ ok: true, text: 'Сохранено. На сайте описание сменится со следующей публикацией.' });
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        const cur = err.details?.current as MediaDto | undefined;
        if (cur) choose(cur);
        setMsg({ ok: false, text: 'Описание уже изменил другой сотрудник – загружено свежее. Проверьте и сохраните ещё раз.' });
      } else setMsg({ ok: false, text: `Не сохранено: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const showUsages = async () => {
    if (!sel) return;
    try {
      setUsages(await browserCall(`/content/media/${sel.id}/usages`));
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  };

  const archive = async () => {
    if (!sel) return;
    setBusy(true);
    setMsg(null);
    try {
      const m = await browserCall<MediaDto>(`/content/media/${sel.id}/archive`, { method: 'POST' });
      setSel(m);
      setMsg({ ok: true, text: 'Файл в архиве: его больше не предлагают при выборе, опубликованные версии его сохраняют.' });
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MEDIA_IN_USE') {
        setUsages({ usages: (err.details?.usages as Usage[]) ?? [], inVersions: false });
        setMsg({ ok: false, text: 'Нельзя в архив: файл показывается на сайте. Сначала замените его в материалах ниже и опубликуйте их.' });
      } else setMsg({ ok: false, text: `Не получилось: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!sel || !confirm('Удалить файл насовсем? Это нельзя отменить.')) return;
    setBusy(true);
    try {
      await browserCall(`/content/media/${sel.id}`, { method: 'DELETE' });
      setSel(null);
      setMsg(null);
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MEDIA_IN_USE') {
        setUsages({ usages: (err.details?.usages as Usage[]) ?? [], inVersions: Boolean(err.details?.inVersions) });
        setMsg({ ok: false, text: 'Нельзя удалить: файл используется или есть в опубликованных версиях. Его можно убрать в архив.' });
      } else setMsg({ ok: false, text: `Не получилось: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const askPurge = () => {
    setPurge({ reasonCode: '', basis: '', confirmed: false, error: '', key: crypto.randomUUID() });
    purgeDlg.current?.showModal();
  };
  const runPurge = async () => {
    if (!sel) return;
    if (!purge.reasonCode) return setPurge({ ...purge, error: 'Выберите причину очистки' });
    if (!purge.confirmed) return setPurge({ ...purge, error: 'Подтвердите: файл удаляется насовсем, отменить нельзя' });
    setBusy(true);
    try {
      const r = await browserCall<{ purged: boolean; affected: unknown[]; filesPending?: boolean }>(`/content/media/${sel.id}/purge`, { method: 'POST', body: { reasonCode: purge.reasonCode, ...(purge.basis.trim() ? { basis: purge.basis.trim() } : {}) }, key: purge.key });
      purgeDlg.current?.close();
      setSel(null);
      setUsages(null);
      setMsg(null);
      // filesPending: запись очищена, но диск не удалил файлы – их уберёт ночная content:media-gc (K22 №227а); «удалены» не пишем.
      const files = r.filesPending ? 'Очищено, файлы будут удалены ночной уборкой.' : 'Фото очищено: все размеры файла удалены с сервера.';
      setUpMsg({ ok: true, text: `${files} Материалов без этого фото: ${r.affected.length}; на сайте вместо него ничего не показывается.` });
      setReload((n) => n + 1);
    } catch (err) {
      setPurge({ ...purge, error: `Не очищено: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="yc-ct__editor">
      <div class="yc-ct__main">
        <section class="yc-ct__box" aria-labelledby="media-up">
          <h2 id="media-up">Загрузить файл</h2>
          <form class="yc-form" onSubmit={(e) => void upload(e)} noValidate>
            <fieldset class="yc-ct__scope">
              <legend class="yc-field__label">Что загружаем</legend>
              <label class="yc-check"><input type="radio" name="purpose" checked={up.purpose === 'image'} onChange={() => setUp({ ...up, purpose: 'image' })} /> Картинка</label>
              <label class="yc-check"><input type="radio" name="purpose" checked={up.purpose === 'document'} onChange={() => setUp({ ...up, purpose: 'document' })} /> PDF – правила розыгрыша</label>
            </fieldset>
            <Field id="media-file" label="Файл" hint={up.purpose === 'image' ? `${TYPE_ERROR}. ${RATIO_HINT.cover} ${RATIO_HINT.banner}` : 'PDF до 10 МБ.'}>
              <input key={fileKey} {...aria('media-file', undefined, true)} class="yc-input" type="file" accept={up.purpose === 'image' ? IMAGE_TYPES.join(',') : 'application/pdf'} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
            </Field>
            {up.purpose === 'image' && (
              <Field id="media-alt" label="Описание картинки (alt)" hint="Что на картинке – для незрячих и поиска. Обязательно перед публикацией материала.">
                <input {...aria('media-alt', undefined, true)} class="yc-input" maxLength={500} value={up.alt} onInput={(e) => setUp({ ...up, alt: e.currentTarget.value })} />
              </Field>
            )}
            <Field id="media-title" label="Подпись для медиатеки">
              <input id="media-title" class="yc-input" maxLength={200} value={up.title} onInput={(e) => setUp({ ...up, title: e.currentTarget.value })} />
            </Field>
            <button class="yc-btn" type="submit" disabled={busy}>Загрузить</button>
            <p class={`yc-alert ${upMsg ? (upMsg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite" data-testid="media-upload-msg">{upMsg?.text ?? ''}</p>
          </form>
        </section>
        <section class="yc-ct__box" aria-labelledby="media-list">
          <h2 id="media-list">Файлы</h2>
          <form class="yc-ct__filters" onSubmit={(e) => { e.preventDefault(); setReload((n) => n + 1); }}>
            <label class="yc-field"><span class="yc-field__label">Поиск</span><input class="yc-input" type="search" value={filter.q} onInput={(e) => setFilter({ ...filter, q: e.currentTarget.value })} /></label>
            <label class="yc-field"><span class="yc-field__label">Вид</span>
              <select class="yc-input" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.currentTarget.value })}><option value="">Все</option><option value="image">Картинки</option><option value="document">PDF</option></select>
            </label>
            <label class="yc-check"><input type="checkbox" checked={filter.archived} onChange={(e) => setFilter({ ...filter, archived: e.currentTarget.checked })} /> Архив</label>
            <button class="yc-btn yc-btn--ghost" type="submit">Показать</button>
          </form>
          {loadError && <p class="yc-alert yc-alert--error" role="alert">{loadError}</p>}
          {items && items.length === 0 && <p class="yc-empty">Файлов по этим условиям нет.</p>}
          <ul class="yc-ct__media" data-testid="media-grid">
            {items?.map((m) => (
              <li class="yc-ct__tile" aria-current={sel?.id === m.id ? 'true' : undefined}>
                <Thumb m={m} />
                <button type="button" class="yc-link" onClick={() => choose(m)}>{m.title ?? m.originalName ?? 'Без имени'}</button>
                <span class="yc-ct__muted">{m.width ? `${m.width}×${m.height}, ` : ''}{kb(m.bytes)}</span>
                {m.purpose === 'image' && !m.alt && <span class="yc-ct__warn">Нет alt</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <aside class="yc-ct__side">
        {sel ? (
          <section class="yc-ct__box" aria-labelledby="media-card" data-testid="media-card">
            <h2 id="media-card">{sel.title ?? sel.originalName ?? 'Файл'}</h2>
            <Thumb m={sel} />
            <p class="yc-ct__muted">{sel.mime}, {sel.width ? `${sel.width}×${sel.height}, ` : ''}{kb(sel.bytes)}; загружен {fmtAt(sel.createdAt, props.timezone)}{sel.status === 'archived' ? '; в архиве' : ''}</p>
            {sel.purpose === 'image' && (
              <Field id="media-edit-alt" label="Описание (alt)" hint={ALT_HINT}>
                <input {...aria('media-edit-alt', undefined, true)} class="yc-input" maxLength={500} value={edit.alt} onInput={(e) => setEdit({ ...edit, alt: e.currentTarget.value })} />
              </Field>
            )}
            <Field id="media-edit-title" label="Подпись">
              <input id="media-edit-title" class="yc-input" maxLength={200} value={edit.title} onInput={(e) => setEdit({ ...edit, title: e.currentTarget.value })} />
            </Field>
            <div class="yc-ct__actions">
              <button type="button" class="yc-btn" disabled={busy} onClick={() => void save()}>Сохранить</button>
              <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void showUsages()}>Где используется</button>
              {props.canArchive && sel.status === 'active' && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={busy} onClick={() => void archive()}>В архив</button>}
              {props.canDelete && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={busy} onClick={() => void remove()}>Удалить</button>}
              {props.canDelete && sel.purpose === 'image' && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={busy} onClick={askPurge}>Очистить по требованию…</button>}
            </div>
            <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
            {usages && (usages.usages.length === 0 && !usages.inVersions ? <p class="yc-ct__muted">Файл нигде не используется.</p> : (
              <>
                <UsageList items={usages.usages} />
                {usages.inVersions && <p class="yc-ct__muted">Есть в опубликованных версиях – удалить нельзя, только в архив.</p>}
              </>
            ))}
          </section>
        ) : <p class="yc-ct__muted" data-testid="media-none">Выберите файл, чтобы поправить описание, посмотреть, где он используется, или убрать в архив.</p>}
      </aside>
      <dialog ref={purgeDlg} class="yc-dialog" aria-labelledby="purge-title">
        <div class="yc-dialog__body">
          <h2 id="purge-title">Очистить фото по требованию?</h2>
          <p>Все размеры файла удаляются с сервера насовсем. Материалы, где фото показывается, получат новую версию без него; старые версии и откат покажут «изображение удалено». Отменить нельзя.</p>
          <Field id="purge-reason" label="Причина">
            <select id="purge-reason" class="yc-input" value={purge.reasonCode} onChange={(e) => setPurge({ ...purge, reasonCode: e.currentTarget.value, error: '' })}>
              <option value="">Выберите…</option>
              {PURGE_REASON_CODES.map((code) => <option value={code}>{PURGE_REASON_LABEL[code]}</option>)}
            </select>
          </Field>
          <Field id="purge-basis" label="Основание (необязательно)" hint="Номер и дата документа. ФИО и содержание заявления не пишите – это попадает в журнал.">
            <input {...aria('purge-basis', undefined, true)} class="yc-input" maxLength={200} value={purge.basis} onInput={(e) => setPurge({ ...purge, basis: e.currentTarget.value })} />
          </Field>
          <label class="yc-check"><input type="checkbox" checked={purge.confirmed} onChange={(e) => setPurge({ ...purge, confirmed: e.currentTarget.checked, error: '' })} /> Понимаю: файл удаляется насовсем</label>
          {purge.error && <p class="yc-field__error" role="alert">{purge.error}</p>}
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => purgeDlg.current?.close()}>Отмена</button>
            <button type="button" class="yc-btn yc-btn--danger" disabled={busy} onClick={() => void runPurge()}>Очистить</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
