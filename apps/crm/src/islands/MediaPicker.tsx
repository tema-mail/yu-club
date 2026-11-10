// S4-85: выбор файла из медиатеки в редакторах (K22 §8): архивные не предлагаются, можно загрузить новый тут же, рекомендуемые пропорции –
// подсказкой (12 §10). У выбранной картинки без alt – предупреждение: публикация с ней вернёт MEDIA_ALT_REQUIRED.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { useLatest } from '../lib/latest.ts';
import { errorText, type MediaDto } from '../lib/content.tsx';
import { ALT_HINT, kb, Thumb, uploadMedia } from './MediaLibrary.tsx';

export interface MediaPickerProps {
  id: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  purpose?: 'image' | 'document';
  hint?: string;
  error?: string | undefined;
  disabled?: boolean;
}

export default function MediaPicker(props: MediaPickerProps) {
  const purpose = props.purpose ?? 'image';
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState<MediaDto | null>(null);
  const [items, setItems] = useState<MediaDto[] | null>(null);
  const [q, setQ] = useState('');
  const [loadError, setLoadError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [upMsg, setUpMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.value) return setCurrent(null);
    if (current?.id === props.value) return;
    browserCall<MediaDto>(`/content/media/${props.value}`).then(setCurrent).catch(() => setCurrent(null));
  }, [props.value]);

  const latest = useLatest(); // поиск сразу после открытия: список при открытии, пришедший позже, не подменяет найденное
  const load = (query = q) => {
    const fresh = latest();
    const p = new URLSearchParams({ type: purpose, limit: '100' });
    if (query.trim()) p.set('q', query.trim());
    setLoadError('');
    browserCall<{ items: MediaDto[] }>(`/content/media?${p}`).then((r) => fresh() && setItems(r.items)).catch((e: unknown) => fresh() && setLoadError(errorText(e)));
  };
  const open = () => {
    setUpMsg('');
    load();
    dialog.current?.showModal();
  };
  const pick = (m: MediaDto) => {
    setCurrent(m);
    props.onChange(m.id);
    dialog.current?.close();
  };
  const upload = async () => {
    if (!file) return setUpMsg('Выберите файл.');
    setBusy(true);
    setUpMsg('');
    try {
      pick((await uploadMedia(file, purpose, alt, '')).media);
      setFile(null);
      setAlt('');
    } catch (e) {
      setUpMsg(`${errorText(e)}. Файл «${file.name}» не загружен.`);
    } finally {
      setBusy(false);
    }
  };

  const describedBy = [props.hint ? `${props.id}-hint` : '', props.error ? `${props.id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div class="yc-field" role="group" aria-labelledby={`${props.id}-label`} aria-describedby={describedBy}>
      <span class="yc-field__label" id={`${props.id}-label`}>{props.label}</span>
      {current ? (
        <div class="yc-ct__tile" data-testid={`${props.id}-current`}>
          <Thumb m={current} />
          <span>{current.title ?? current.originalName ?? 'Файл'}</span>
          {purpose === 'image' && !current.alt && <span class="yc-ct__warn">Нет описания (alt) – без него не опубликовать. <a href="/content/media">Заполнить в медиатеке</a></span>}
        </div>
      ) : <span class="yc-ct__muted">Не выбрано.</span>}
      <div class="yc-ct__pick">
        <button type="button" id={props.id} class="yc-btn yc-btn--ghost" aria-invalid={props.error ? 'true' : undefined} disabled={props.disabled} onClick={open}>{current ? 'Заменить…' : 'Выбрать из медиатеки…'}</button>
        {current && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={props.disabled} onClick={() => { setCurrent(null); props.onChange(''); }}>Убрать</button>}
      </div>
      {props.hint && <span class="yc-field__hint" id={`${props.id}-hint`}>{props.hint}</span>}
      {props.error && <span class="yc-field__error" id={`${props.id}-error`} role="alert">{props.error}</span>}
      <dialog ref={dialog} class="yc-dialog yc-dialog--wide" aria-labelledby={`${props.id}-dlg`}>
        <div class="yc-dialog__body">
          <h2 id={`${props.id}-dlg`}>{props.label}: выбор файла</h2>
          <form class="yc-ct__pick" onSubmit={(e) => { e.preventDefault(); load(); }}>
            <input class="yc-input" type="search" aria-label="Поиск по описанию и имени" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
            <button class="yc-btn yc-btn--ghost" type="submit">Найти</button>
          </form>
          {loadError && <p class="yc-alert yc-alert--error" role="alert">{loadError}</p>}
          {items && items.length === 0 && <p class="yc-empty">Подходящих файлов нет – загрузите новый ниже.</p>}
          <ul class="yc-ct__media">
            {items?.map((m) => (
              <li class="yc-ct__tile">
                <Thumb m={m} />
                <button type="button" class="yc-btn yc-btn--ghost" onClick={() => pick(m)} aria-label={`Выбрать: ${m.title ?? m.originalName ?? m.id}`}>Выбрать</button>
                <span class="yc-ct__muted">{m.title ?? m.originalName}{m.width ? `, ${m.width}×${m.height}` : ''}, {kb(m.bytes)}</span>
                {purpose === 'image' && !m.alt && <span class="yc-ct__warn">Нет alt</span>}
              </li>
            ))}
          </ul>
          <fieldset class="yc-ct__scope">
            <legend class="yc-field__label">Или загрузить новый</legend>
            <input class="yc-input" type="file" aria-label="Новый файл" accept={purpose === 'image' ? 'image/jpeg,image/png,image/webp' : 'application/pdf'} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
            {purpose === 'image' && <input class="yc-input" aria-label="Описание новой картинки (alt)" placeholder="Описание (alt)" maxLength={500} value={alt} onInput={(e) => setAlt(e.currentTarget.value)} />}
            <span class="yc-field__hint">{purpose === 'image' ? `Можно JPG, PNG, WebP до 10 МБ. ${ALT_HINT}` : 'PDF до 10 МБ.'}</span>
            <button type="button" class="yc-btn" disabled={busy} onClick={() => void upload()}>Загрузить и выбрать</button>
            {upMsg && <p class="yc-alert yc-alert--error" role="alert">{upMsg}</p>}
          </fieldset>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Закрыть</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
