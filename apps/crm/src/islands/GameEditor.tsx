// S4-86: карточка игры (K22 §2, §9; 12 §6): одна на сеть, правит и публикует только Владелец (content.network.manage), остальные видят
// карточку только для чтения. Полнота: название, кратко, обложка с alt; у PlayStation – платформы; есть «подробно» – нужен адрес.
import { useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { aria, clean, ConflictNotice, DraftActions, Field, fieldErrors, STATUS_BADGE, STATUS_LABEL, type AllowedAction, type ContentStatus, type DraftDto } from '../lib/content.tsx';
import { RATIO_HINT } from './MediaLibrary.tsx';
import MediaPicker from './MediaPicker.tsx';

export type Direction = 'pc' | 'vr' | 'playstation';
export const DIRECTION_LABEL: Record<Direction, string> = { pc: 'ПК', vr: 'VR', playstation: 'PlayStation' };
const AGES = ['0+', '6+', '12+', '16+', '18+'];
export interface GameDto extends DraftDto { id: string; direction: Direction; slug: string | null; branches?: Array<{ branchId: string; available: boolean; note: string | null }> }

/** Те же условия, что проверяет сервер для игры: всё – content.network.manage, дальше – по статусу. */
export function gameActions(status: ContentStatus, canManage: boolean): AllowedAction[] {
  if (!canManage) return [];
  const out: AllowedAction[] = [];
  if (status !== 'archived') out.push('edit', 'publish', 'rollback');
  if (status === 'published') out.push('unpublish');
  if (status === 'draft' || status === 'unpublished') out.push('archive');
  return out;
}

const TEXT = [
  { name: 'title', label: 'Название', max: 120 },
  { name: 'short', label: 'Коротко', max: 200, area: true, hint: 'Для плитки каталога.' },
  { name: 'full', label: 'Подробно', area: true, hint: 'Markdown без HTML. Пусто – у игры только плитка, без своей страницы.' },
  { name: 'genres', label: 'Жанры', hint: 'Через запятую.' },
  { name: 'platforms', label: 'Платформы', hint: 'Через запятую. У PlayStation обязательно: PS4, PS5.' },
  { name: 'sortOrder', label: 'Порядок в каталоге', hint: 'Число: меньше – выше.' },
] as const;
const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
const formOf = (d: Record<string, unknown>) => ({
  title: String(d.title ?? ''), short: String(d.short ?? ''), full: String(d.full ?? ''), genres: list(d.genres), platforms: list(d.platforms),
  sortOrder: d.sortOrder === undefined ? '' : String(d.sortOrder), ageRating: String(d.ageRating ?? ''), coverMediaId: String(d.coverMediaId ?? ''), slug: String(d.slug ?? ''),
});

export default function GameEditor(props: { initial: GameDto | null; direction: Direction; canManage: boolean }) {
  const [dto, setDto] = useState<GameDto | null>(props.initial);
  const [form, setForm] = useState(formOf(dto?.draft ?? {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const direction = dto?.direction ?? props.direction;
  const allowed = gameActions(dto?.status ?? 'draft', props.canManage);
  const readOnly = !allowed.includes('edit');
  const set = (name: keyof typeof form) => (e: Event) => {
    setForm({ ...form, [name]: (e.currentTarget as HTMLInputElement).value });
    setDirty(true);
  };

  const draftBody = () => {
    const split = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
    const keep = { ...(dto?.draft ?? {}) };
    const n = form.sortOrder.trim() === '' ? undefined : Number(form.sortOrder);
    return clean({ ...keep, title: form.title, short: form.short, full: form.full, slug: form.slug, coverMediaId: form.coverMediaId, ageRating: form.ageRating, genres: split(form.genres), platforms: split(form.platforms), sortOrder: n !== undefined && Number.isInteger(n) ? n : undefined });
  };
  const reload = async () => {
    if (!dto) return;
    const fresh = await browserCall<GameDto>(`/content/games/${dto.id}/draft`);
    setDto(fresh);
    setForm(formOf(fresh.draft));
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
    if (form.sortOrder.trim() && !/^\d{1,6}$/.test(form.sortOrder.trim())) return setErrors({ sortOrder: 'Целое число от 0', _: '' });
    setBusy(true);
    try {
      if (!dto) {
        const created = await browserCall<{ id: string }>('/content/games', { method: 'POST', body: { direction, draft: draftBody() }, key });
        location.assign(`/content/games/${created.id}?created=1`);
        return;
      }
      const saved = await browserCall<DraftDto>(`/content/games/${dto.id}/draft`, { method: 'PUT', body: { rowVersion: dto.rowVersion, draft: draftBody() }, key });
      setDto({ ...dto, ...saved } as GameDto);
      setDirty(false);
      setMsg({ ok: true, text: 'Черновик сохранён. На сайте ничего не изменилось до публикации.' });
    } catch (e) {
      fail(e);
    } finally {
      setKey(crypto.randomUUID());
      setBusy(false);
    }
  };

  return (
    <div class="yc-ct__main">
      {dto && <p class="yc-ct__meta"><span class={`yc-badge yc-badge--${STATUS_BADGE[dto.status]}`}>{STATUS_LABEL[dto.status]}</span> <span>Направление: {DIRECTION_LABEL[direction]}</span></p>}
      {readOnly && <p class="yc-ct__muted">Карточку игры правит Владелец: она одна на всю сеть.</p>}
      {conflict && <ConflictNotice onReload={() => void reload()} />}
      <form class="yc-form yc-form--wide" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <fieldset class="yc-ct__fieldset" disabled={readOnly || busy}>
          {TEXT.map((f) => {
            const id = `game-${f.name}`;
            const err = errors[f.name];
            const common = { ...aria(id, err, 'hint' in f), class: 'yc-input', value: form[f.name], onInput: set(f.name), maxLength: 'max' in f ? f.max : undefined };
            return <Field id={id} label={f.label} error={err} hint={'hint' in f ? f.hint : undefined}>{'area' in f ? <textarea {...common} rows={f.name === 'full' ? 8 : 2} /> : <input {...common} type="text" />}</Field>;
          })}
          <Field id="game-ageRating" label="Возраст" error={errors.ageRating}>
            <select {...aria('game-ageRating', errors.ageRating)} class="yc-input" value={form.ageRating} onChange={set('ageRating')}><option value="">Не указан</option>{AGES.map((a) => <option value={a}>{a}</option>)}</select>
          </Field>
          <Field id="game-slug" label="Адрес страницы" error={errors.slug} hint="Латинское название издателя: латиница, цифры и дефис. Нужен, если заполнено «Подробно».">
            <input {...aria('game-slug', errors.slug, true)} class="yc-input" maxLength={200} value={form.slug} onInput={set('slug')} />
          </Field>
          <MediaPicker id="game-cover" label="Обложка" value={form.coverMediaId} onChange={(id) => { setForm({ ...form, coverMediaId: id }); setDirty(true); }} hint={RATIO_HINT.cover} error={errors.coverMediaId} disabled={readOnly || busy} />
        </fieldset>
        <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
      </form>
      <DraftActions
        base={dto ? `/content/games/${dto.id}` : ''}
        allowed={dto ? allowed : props.canManage ? ['edit'] : []}
        status={dto?.status ?? 'draft'}
        rowVersion={dto?.rowVersion ?? 1}
        busy={busy}
        dirty={dirty || !dto}
        onSave={() => void save()}
        onDone={(_saved, text) => void reload().then(() => setMsg({ ok: true, text }))}
        onError={fail}
      />
    </div>
  );
}
