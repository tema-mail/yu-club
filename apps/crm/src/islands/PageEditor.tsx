// S4-87: страницы из CMS (K22 §2, §5, §7; K11 №221–223): about, rules, contacts_intro, юридические с версией документа (публикует только
// Владелец – content.legal.publish), страницы комнат и филиалов (текст, галерея, особенности; факты – из сети и ресурсов). Строка страницы
// создаётся при первом сохранении (адрес фиксирован картой сайта). Версия документа опубликованной редакции неизменна: новый текст –
// новый номер (иначе CONTENT_INCOMPLETE с REUSED у поля).
import { useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { aria, clean, ConflictNotice, DraftActions, Field, fieldErrors, STATUS_BADGE, STATUS_LABEL, type AllowedAction, type ContentStatus, type DraftDto } from '../lib/content.tsx';
import { RATIO_HINT } from './MediaLibrary.tsx';
import MediaPicker from './MediaPicker.tsx';

export type PageKind = 'page' | 'room' | 'branch';
export interface PageEditorProps {
  kind: PageKind;
  /** Путь API без /draft: /content/pages/about, /content/rooms/{roomId}, /content/branches/{branchId}. */
  base: string;
  /** ?cityId= у страницы города. */
  query: string;
  initial: DraftDto;
  legal: boolean;
  /** Номер документа живой редакции (юридические): показывается и не меняется. */
  liveDocumentVersion: string | null;
  docKey: string;
  canEdit: boolean;
  canPublish: boolean;
}

export function pageActions(status: ContentStatus, canEdit: boolean, canPublish: boolean): AllowedAction[] {
  const out: AllowedAction[] = [];
  if (canEdit) out.push('edit');
  if (canPublish) {
    out.push('publish', 'rollback');
    if (status === 'published') out.push('unpublish');
  }
  return out;
}

const lines = (v: unknown) => (Array.isArray(v) ? v.join('\n') : '');
const formOf = (d: Record<string, unknown>) => {
  const postal = (d.postal ?? {}) as Record<string, string>;
  const geo = (d.geo ?? {}) as Record<string, number>;
  return {
    title: String(d.title ?? ''), body: String(d.body ?? ''), documentVersion: String(d.documentVersion ?? ''), description: String(d.description ?? ''), features: lines(d.features),
    rentFormatsText: String(d.rentFormatsText ?? ''), howToGet: String(d.howToGet ?? ''), street: postal.street ?? '', locality: postal.locality ?? '', region: postal.region ?? '', postalCode: postal.postalCode ?? '',
    lat: geo.lat === undefined ? '' : String(geo.lat), lng: geo.lng === undefined ? '' : String(geo.lng),
  };
};

export default function PageEditor(props: PageEditorProps) {
  const [dto, setDto] = useState<DraftDto>(props.initial);
  const [form, setForm] = useState(formOf(dto.draft));
  const [gallery, setGallery] = useState<string[]>(Array.isArray(dto.draft.gallery) ? (dto.draft.gallery as string[]) : []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [liveDoc, setLiveDoc] = useState(props.liveDocumentVersion);
  const allowed = pageActions(dto.status, props.canEdit, props.canPublish);
  const readOnly = !props.canEdit;
  const set = (name: keyof typeof form) => (e: Event) => {
    setForm({ ...form, [name]: (e.currentTarget as HTMLInputElement).value });
    setDirty(true);
  };

  const draftBody = (): Record<string, unknown> => {
    const keep = { ...dto.draft };
    if (props.kind === 'page') return clean({ ...keep, title: form.title, body: form.body, documentVersion: props.legal ? form.documentVersion : undefined });
    const features = form.features.split('\n').map((x) => x.trim()).filter(Boolean);
    const common = { ...keep, description: form.description, features, gallery: gallery.filter(Boolean) };
    if (props.kind === 'room') return clean({ ...common, rentFormatsText: form.rentFormatsText });
    const postal = form.street || form.locality || form.region || form.postalCode ? { street: form.street.trim(), locality: form.locality.trim(), region: form.region.trim(), postalCode: form.postalCode.trim() } : undefined;
    const geo = form.lat && form.lng ? { lat: Number(form.lat.replace(',', '.')), lng: Number(form.lng.replace(',', '.')) } : undefined;
    return clean({ ...common, howToGet: form.howToGet, postal, geo });
  };
  const reload = async () => {
    const fresh = await browserCall<DraftDto>(`${props.base}/draft${props.query}`);
    setDto(fresh);
    setForm(formOf(fresh.draft));
    setGallery(Array.isArray(fresh.draft.gallery) ? (fresh.draft.gallery as string[]) : []);
    setConflict(false);
    setErrors({});
    setDirty(false);
  };
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') return setConflict(true);
    const fe = fieldErrors(e);
    setErrors(fe);
    setMsg({ ok: false, text: fe._ ?? '' });
  };
  const save = async () => {
    setErrors({});
    setMsg(null);
    if (props.kind === 'branch' && form.postalCode && !/^\d{6}$/.test(form.postalCode.trim())) return setErrors({ postal: 'Индекс – 6 цифр' });
    setBusy(true);
    try {
      const saved = await browserCall<DraftDto>(`${props.base}/draft${props.query}`, { method: 'PUT', body: { rowVersion: dto.rowVersion, draft: draftBody() } });
      setDto(saved);
      setDirty(false);
      setMsg({ ok: true, text: 'Черновик сохранён. На сайте ничего не изменилось до публикации.' });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const area = (name: 'body' | 'description' | 'rentFormatsText' | 'howToGet' | 'features', label: string, hint?: string, rows = 4) => {
    const id = `page-${name}`;
    return <Field id={id} label={label} error={errors[name]} hint={hint}><textarea {...aria(id, errors[name], Boolean(hint))} class="yc-input" rows={rows} value={form[name]} onInput={set(name)} /></Field>;
  };
  const text = (name: 'title' | 'street' | 'locality' | 'region' | 'postalCode' | 'lat' | 'lng', label: string, max = 200) => {
    const id = `page-${name}`;
    return <Field id={id} label={label} error={errors[name]}><input {...aria(id, errors[name])} class="yc-input" maxLength={max} value={form[name]} onInput={set(name)} /></Field>;
  };

  return (
    <div class="yc-ct__main">
      <p class="yc-ct__meta">
        <span class={`yc-badge yc-badge--${STATUS_BADGE[dto.status]}`}>{STATUS_LABEL[dto.status]}</span>
        {!dto.id && <span class="yc-ct__muted">Страницы ещё нет: она появится при первом сохранении.</span>}
      </p>
      {props.legal && (
        <p class="yc-ct__box" data-testid="doc-version">
          {liveDoc ? <>На сайте версия документа <strong>{liveDoc}</strong>. Она не меняется: согласия в журнале ссылаются на неё. Новый текст – новый номер версии.</> : 'Документ ещё не опубликован – на сайте «Документ готовится».'}
        </p>
      )}
      {readOnly && <p class="yc-ct__muted">{props.legal ? 'Юридические документы публикует только Владелец.' : 'Править эту страницу нельзя с вашими правами.'}</p>}
      {conflict && <ConflictNotice onReload={() => void reload()} />}
      <form class="yc-form yc-form--wide" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <fieldset class="yc-ct__fieldset" disabled={readOnly || busy}>
          {props.kind === 'page' && text('title', 'Заголовок')}
          {props.kind === 'page' && area('body', 'Текст', 'Markdown без HTML: заголовки ##, списки, ссылки.', 12)}
          {props.legal && (
            <Field id="page-documentVersion" label="Версия документа" error={errors.documentVersion} hint={`Формат: ${props.docKey}-ГГГГ-ММ-ДД, например ${props.docKey}-2026-11-10.`}>
              <input {...aria('page-documentVersion', errors.documentVersion, true)} class="yc-input" maxLength={80} value={form.documentVersion} onInput={set('documentVersion')} />
            </Field>
          )}
          {props.kind !== 'page' && area('description', 'Описание', 'Markdown без HTML. Адрес, часы и вместимость сайт берёт из карточки филиала и ресурсов.', 6)}
          {props.kind !== 'page' && area('features', 'Особенности', 'По одной в строке.', 4)}
          {props.kind === 'room' && area('rentFormatsText', 'Форматы аренды')}
          {props.kind === 'branch' && area('howToGet', 'Как добраться')}
          {props.kind === 'branch' && (
            <fieldset class="yc-ct__scope" aria-describedby={errors.postal ? 'page-postal-error' : undefined}>
              <legend class="yc-field__label">Почтовый адрес для разметки</legend>
              {text('street', 'Улица и дом')}{text('locality', 'Населённый пункт', 120)}{text('region', 'Регион', 120)}{text('postalCode', 'Индекс', 6)}
              {errors.postal && <span class="yc-field__error" id="page-postal-error" role="alert">{errors.postal}</span>}
              {text('lat', 'Широта', 20)}{text('lng', 'Долгота', 20)}
            </fieldset>
          )}
          {props.kind !== 'page' && (
            <fieldset class="yc-ct__scope" aria-describedby={errors.gallery ? 'page-gallery-error' : undefined}>
              <legend class="yc-field__label">Галерея</legend>
              <span class="yc-field__hint">{RATIO_HINT.gallery} У каждого фото нужно описание (alt).</span>
              {[...gallery, ''].slice(0, 20).map((id, i) => (
                <MediaPicker key={`${i}-${id}`} id={`page-gallery-${i}`} label={id ? `Фото ${i + 1}` : 'Добавить фото'} value={id} disabled={readOnly || busy}
                  onChange={(v) => { const next = [...gallery]; if (v) next[i] = v; else next.splice(i, 1); setGallery(next.filter(Boolean)); setDirty(true); }} />
              ))}
              {errors.gallery && <span class="yc-field__error" id="page-gallery-error" role="alert">{errors.gallery}</span>}
            </fieldset>
          )}
        </fieldset>
        <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
      </form>
      <DraftActions
        base={props.base}
        query={props.query}
        allowed={allowed}
        status={dto.status}
        rowVersion={dto.rowVersion}
        busy={busy}
        dirty={dirty || !dto.id}
        onSave={() => void save()}
        onDone={(_saved, t) => void reload().then(() => { if (props.legal) setLiveDoc(form.documentVersion || liveDoc); setMsg({ ok: true, text: t }); })}
        onError={fail}
      />
    </div>
  );
}
