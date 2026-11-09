// S4-84: редактор публикации (K22 §2–§4, §9; 12 §8, §9.2, §14.2): охват сеть / город / филиалы, поля по типу, черновик с rowVersion,
// публикация, снятие и архив с причиной. Ошибки – у полей (CONTENT_INCOMPLETE, CONTENT_INVALID, SLUG_*); VERSION_CONFLICT – предложение
// обновить. Кнопки – по allowedActions ответа API (у Администратора «Опубликовать» нет); защита – на сервере.
import { useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { RATIO_HINT } from './MediaLibrary.tsx';
import MediaPicker from './MediaPicker.tsx';
import SeoPanel, { seoLengthErrors, type SeoValue } from './SeoPanel.tsx';
import { aria, clean, ConflictNotice, DraftActions, Field, fieldErrors, fmtAt, fromLocalInput, STATUS_BADGE, STATUS_LABEL, toLocalInput, TYPE_LABEL, type BranchRef, type PublicationDto, type PublicationType, type Scope } from '../lib/content.tsx';

export interface PublicationEditorProps {
  initial: PublicationDto | null;
  type: PublicationType;
  branches: BranchRef[];
  /** content.network.manage – можно выбрать «Вся сеть». */
  canNetwork: boolean;
  /** Для нового черновика: право content.draft.edit (у существующего – allowedActions). */
  canCreate: boolean;
  timezone: string;
}

type Kind = 'text' | 'area' | 'date' | 'path';
interface Def { name: string; label: string; kind: Kind; max?: number; hint?: string; types?: PublicationType[] }
const FIELDS: Def[] = [
  { name: 'title', label: 'Заголовок', kind: 'text', max: 120 },
  { name: 'lead', label: 'Анонс', kind: 'area', max: 300, hint: 'Одна-две фразы для карточки в списке и описания страницы.' },
  { name: 'body', label: 'Текст', kind: 'area', hint: 'Markdown без HTML. Картинка в тексте – только из медиатеки.' },
  { name: 'publishFrom', label: 'Показывать с', kind: 'date' },
  { name: 'publishTo', label: 'Показывать до', kind: 'date', hint: 'У акции обязательно. Пусто – без срока.' },
  { name: 'eventDate', label: 'Дата турнира', kind: 'date', types: ['tournament'] },
  { name: 'conditions', label: 'Условия акции', kind: 'area', max: 5000, types: ['promotion', 'giveaway', 'tournament'] },
  { name: 'restrictions', label: 'Ограничения', kind: 'area', max: 5000, types: ['promotion'] },
  { name: 'resultsDate', label: 'Дата итогов', kind: 'date', types: ['giveaway'] },
  { name: 'prize', label: 'Приз', kind: 'text', max: 500, types: ['giveaway'] },
  { name: 'rulesBody', label: 'Правила розыгрыша', kind: 'area', types: ['giveaway'], hint: 'Текстом или файлом PDF – одно из двух обязательно.' },
  { name: 'ctaLabel', label: 'Текст кнопки', kind: 'text', max: 60, hint: 'Например: «Записаться». Пусто – без кнопки.' },
  { name: 'ctaUrl', label: 'Ссылка кнопки', kind: 'path', max: 500, hint: 'Только путь этого сайта, например /booking/.' },
];

const seoOf = (d: Record<string, unknown>): SeoValue => ({ slug: String(d.slug ?? ''), seoTitle: String(d.seoTitle ?? ''), seoDescription: String(d.seoDescription ?? ''), h1: String(d.h1 ?? ''), indexable: d.indexable !== false });
const formOf = (d: Record<string, unknown>) => Object.fromEntries(FIELDS.map((f) => [f.name, f.kind === 'date' ? toLocalInput(d[f.name]) : String(d[f.name] ?? '')]));

export default function PublicationEditor(props: PublicationEditorProps) {
  const { branches, timezone } = props;
  const [dto, setDto] = useState<PublicationDto | null>(props.initial);
  const base = (dto?.draft ?? {}) as Record<string, unknown>;
  const [form, setForm] = useState<Record<string, string>>(formOf(base));
  const initialScope = (base.scope as Scope | undefined) ?? (props.canNetwork ? { type: 'network' } : { type: 'branch', branchIds: branches.length === 1 ? [branches[0]!.id] : [] });
  const [scope, setScope] = useState<Scope>(initialScope);
  const [cover, setCover] = useState(String(base.coverMediaId ?? ''));
  const [rulesMediaId, setRulesMediaId] = useState(String(base.rulesMediaId ?? ''));
  const [seo, setSeo] = useState<SeoValue>(seoOf(base));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());

  const type = dto?.type ?? props.type;
  const allowed = dto ? dto.allowedActions : props.canCreate ? (['edit'] as const).slice() : [];
  const readOnly = !allowed.includes('edit');
  const cities = [...new Map(branches.map((b) => [b.cityId, b.cityName])).entries()];
  const set = (name: string) => (e: Event) => {
    setForm({ ...form, [name]: (e.currentTarget as HTMLInputElement).value });
    setDirty(true);
  };

  const draftBody = () => {
    const values: Record<string, unknown> = {};
    for (const f of FIELDS) values[f.name] = f.kind === 'date' ? fromLocalInput(form[f.name] ?? '') : form[f.name];
    const keep = { ...base };
    for (const f of FIELDS) delete keep[f.name];
    return clean({ ...keep, ...values, scope, coverMediaId: cover || undefined, rulesMediaId: rulesMediaId || undefined, ...seo });
  };

  const reload = async () => {
    if (!dto) return;
    const fresh = await browserCall<PublicationDto>(`/content/publications/${dto.id}`);
    setDto(fresh);
    setForm(formOf(fresh.draft));
    setScope((fresh.draft.scope as Scope) ?? { type: 'network' });
    setCover(String(fresh.draft.coverMediaId ?? ''));
    setRulesMediaId(String(fresh.draft.rulesMediaId ?? ''));
    setSeo(seoOf(fresh.draft));
    setConflict(false);
    setErrors({});
    setDirty(false);
    setMsg({ ok: true, text: 'Загружен свежий черновик.' });
  };

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setConflict(true);
      setMsg(null);
      return;
    }
    const fe = fieldErrors(e);
    setErrors(fe);
    setMsg({ ok: false, text: fe._ ?? '' });
  };

  const save = async () => {
    setErrors({});
    setMsg(null);
    if (scope.type === 'city' && scope.cityIds.length === 0) return setErrors({ scope: 'Выберите хотя бы один город', _: 'Проверьте отмеченные поля.' });
    if (scope.type === 'branch' && scope.branchIds.length === 0) return setErrors({ scope: 'Выберите хотя бы один филиал', _: 'Проверьте отмеченные поля.' });
    const long = seoLengthErrors(seo);
    if (Object.keys(long).length) {
      setErrors(long);
      return setMsg({ ok: false, text: 'Не сохранено: сократите отмеченные поля SEO.' });
    }
    setBusy(true);
    try {
      if (!dto) {
        const created = await browserCall<{ id: string }>('/content/publications', { method: 'POST', body: { type, draft: draftBody() }, key });
        location.assign(`/content/publications/${created.id}?created=1`);
        return;
      }
      const saved = await browserCall<PublicationDto>(`/content/publications/${dto.id}/draft`, { method: 'PUT', body: { rowVersion: dto.rowVersion, draft: draftBody() }, key });
      setDto({ ...dto, ...saved });
      setDirty(false);
      setKey(crypto.randomUUID());
      setMsg({ ok: true, text: 'Черновик сохранён. На сайте ничего не изменилось до публикации.' });
    } catch (e) {
      setKey(crypto.randomUUID());
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const visible = FIELDS.filter((f) => !f.types || f.types.includes(type));

  return (
    <div class="yc-ct__editor">
      <div class="yc-ct__main">
        {dto && (
          <p class="yc-ct__meta">
            <span class={`yc-badge yc-badge--${STATUS_BADGE[dto.status]}`}>{STATUS_LABEL[dto.status]}</span>
            {dto.liveVersionId && dto.status === 'published' && <span> На сайте опубликованная версия; правки черновика попадут туда только после публикации.</span>}
            <span class="yc-field__hint"> Черновик изменён {fmtAt(dto.draftUpdatedAt, timezone)}.</span>
          </p>
        )}
        {conflict && <ConflictNotice onReload={() => void reload()} />}
        <form class="yc-form yc-form--wide" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <fieldset class="yc-ct__fieldset" disabled={readOnly || busy}>
            <fieldset class="yc-ct__scope" aria-describedby={errors.scope ? 'scope-error' : undefined}>
              <legend class="yc-field__label">Где показывать</legend>
              {props.canNetwork && (
                <label class="yc-check"><input type="radio" name="scope" checked={scope.type === 'network'} onChange={() => { setScope({ type: 'network' }); setDirty(true); }} /> Вся сеть</label>
              )}
              <label class="yc-check"><input type="radio" name="scope" checked={scope.type === 'city'} onChange={() => { setScope({ type: 'city', cityIds: [] }); setDirty(true); }} /> Города</label>
              {scope.type === 'city' && (
                <div class="yc-ct__checks">
                  {cities.map(([id, name]) => (
                    <label class="yc-check"><input type="checkbox" checked={scope.cityIds.includes(id)} onChange={(e) => { setScope({ type: 'city', cityIds: toggle(scope.cityIds, id, e.currentTarget.checked) }); setDirty(true); }} /> {name}</label>
                  ))}
                </div>
              )}
              <label class="yc-check"><input type="radio" name="scope" checked={scope.type === 'branch'} onChange={() => { setScope({ type: 'branch', branchIds: [] }); setDirty(true); }} /> Филиалы</label>
              {scope.type === 'branch' && (
                <div class="yc-ct__checks">
                  {branches.map((b) => (
                    <label class="yc-check"><input type="checkbox" checked={scope.branchIds.includes(b.id)} onChange={(e) => { setScope({ type: 'branch', branchIds: toggle(scope.branchIds, b.id, e.currentTarget.checked) }); setDirty(true); }} /> {branches.length > 1 && cities.length > 1 ? `${b.cityName} – ${b.name}` : b.name}</label>
                  ))}
                </div>
              )}
              {errors.scope && <span class="yc-field__error" id="scope-error" role="alert">{errors.scope}</span>}
              <span class="yc-field__hint">Охват с несколькими филиалами требует права на каждый из них.</span>
            </fieldset>
            {visible.map((f) => {
              const id = `pub-${f.name}`;
              const err = errors[f.name] ?? (f.name === 'rulesBody' ? errors.rules : undefined);
              const common = { ...aria(id, err, Boolean(f.hint)), class: 'yc-input', value: form[f.name] ?? '', onInput: set(f.name), maxLength: f.max };
              return (
                <Field id={id} label={f.label} error={err} hint={f.hint}>
                  {f.kind === 'area' ? <textarea {...common} rows={f.name === 'body' ? 10 : 3} /> : f.kind === 'date' ? <input {...common} type="datetime-local" /> : <input {...common} type="text" />}
                </Field>
              );
            })}
            <MediaPicker id="pub-cover" label="Обложка" value={cover} onChange={(id) => { setCover(id); setDirty(true); }} hint={RATIO_HINT.cover} error={errors.coverMediaId} disabled={readOnly || busy} />
            {type === 'giveaway' && (
              <MediaPicker id="pub-rules" label="Правила розыгрыша файлом (PDF)" purpose="document" value={rulesMediaId} onChange={(id) => { setRulesMediaId(id); setDirty(true); }} error={errors.rulesMediaId} disabled={readOnly || busy} />
            )}
            <SeoPanel entityType="publication" parent={type} entityId={dto?.id ?? null} liveSlug={dto?.slug ?? null} published={dto?.status === 'published'} title={form.title ?? ''} lead={form.lead ?? ''}
              value={seo} onChange={(v) => { setSeo(v); setDirty(true); }} errors={errors} disabled={readOnly || busy} />
          </fieldset>
          <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
        </form>
        <DraftActions
          base={dto ? `/content/publications/${dto.id}` : ''}
          allowed={allowed}
          status={dto?.status ?? 'draft'}
          rowVersion={dto?.rowVersion ?? 1}
          busy={busy}
          dirty={dirty || !dto}
          onSave={() => void save()}
          onDone={(saved, text) => { setDto(dto ? { ...dto, ...saved } as PublicationDto : dto); setErrors({}); setMsg({ ok: true, text }); void reload().then(() => setMsg({ ok: true, text })); }}
          onError={fail}
        />
        {!dto && <p class="yc-field__hint">Новый материал: {TYPE_LABEL[type]}. После первого сохранения появятся публикация, предпросмотр и история.</p>}
      </div>
    </div>
  );
}
