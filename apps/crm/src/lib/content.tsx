// Общее для экранов «Контент» (S4-84…S4-89, K22, K23): типы ответов API content, подписи, ошибки у полей (12 §14.2),
// вкладки раздела и панель действий черновика с причиной. Права – на сервере; здесь только подсказка экрану.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from './api.ts';

export type ContentStatus = 'draft' | 'published' | 'unpublished' | 'archived';
export type PublicationType = 'news' | 'promotion' | 'giveaway' | 'tournament';
export type Scope = { type: 'network' } | { type: 'city'; cityIds: string[] } | { type: 'branch'; branchIds: string[] };
export type EntityType = 'publication' | 'game' | 'room_page' | 'branch_page' | 'content_page' | 'home_block';
export type AllowedAction = 'edit' | 'publish' | 'unpublish' | 'archive' | 'rollback';

/** draftDto сервера (versions.ts). У ещё не созданной страницы id = null и rowVersion = 1. */
export interface DraftDto {
  id: string | null;
  status: ContentStatus;
  draft: Record<string, unknown>;
  rowVersion: number;
  liveVersionId: string | null;
  draftUpdatedAt?: string;
  draftUpdatedBy?: string;
  createdAt?: string;
  archivedAt?: string | null;
}
export interface PublicationDto extends DraftDto {
  id: string;
  type: PublicationType;
  slug: string | null;
  live?: Record<string, unknown> | null;
  allowedActions: AllowedAction[];
}
export interface VersionDto {
  id: string;
  versionNo: number;
  action: 'publish' | 'rollback_publish';
  publishedBy: string;
  publishedByName: string | null;
  publishedAt: string;
  reason: string | null;
  sourceVersionId: string | null;
  snapshot: Record<string, unknown>;
}
export interface MediaDto {
  id: string; mime: string; bytes: number; width: number | null; height: number | null; url: string; alt: string | null; title: string | null;
  originalName: string | null; purpose: 'image' | 'document'; status: 'active' | 'archived' | 'purged'; createdAt: string; archivedAt: string | null; rowVersion: number;
}
export interface BranchRef { id: string; name: string; cityId: string; cityName: string; timezone: string }

export const STATUS_LABEL: Record<ContentStatus, string> = { draft: 'Черновик', published: 'Опубликовано', unpublished: 'Снято с сайта', archived: 'В архиве' };
export const STATUS_BADGE: Record<ContentStatus, string> = { draft: 'preparing', published: 'active', unpublished: 'temporarily_closed', archived: 'archived' };
export const TYPE_LABEL: Record<PublicationType, string> = { news: 'Новость', promotion: 'Акция', giveaway: 'Розыгрыш', tournament: 'Турнир' };
export const ENTITY_LABEL: Record<string, string> = { publication: 'Публикация', game: 'Игра', room_page: 'Страница комнаты', branch_page: 'Страница филиала', content_page: 'Страница', home_block: 'Блок главной' };

/** Подписи полей черновиков – для ошибок у поля и сравнения версий. */
export const FIELD_LABEL: Record<string, string> = {
  scope: 'Где показывать', title: 'Заголовок', lead: 'Анонс', body: 'Текст', slug: 'Адрес страницы', coverMediaId: 'Обложка', cover: 'Обложка',
  publishFrom: 'Показывать с', publishTo: 'Показывать до', eventDate: 'Дата события', conditions: 'Условия', restrictions: 'Ограничения',
  ctaLabel: 'Текст кнопки', ctaUrl: 'Ссылка кнопки', resultsDate: 'Дата итогов', prize: 'Приз', rulesBody: 'Правила текстом', rulesMediaId: 'Правила файлом',
  rules: 'Правила розыгрыша', indexable: 'Индексировать', seoTitle: 'Title', seoDescription: 'Description', h1: 'H1', ogMediaId: 'Картинка для соцсетей', og: 'Картинка для соцсетей',
  short: 'Коротко', full: 'Подробно', genres: 'Жанры', ageRating: 'Возраст', platforms: 'Платформы', sortOrder: 'Порядок', documentVersion: 'Версия документа',
  description: 'Описание', gallery: 'Галерея', features: 'Особенности', rentFormatsText: 'Форматы аренды', howToGet: 'Как добраться', postal: 'Почтовый адрес', geo: 'Координаты',
  payload: 'Содержимое блока', blockType: 'Тип блока',
};
const CODE_TEXT: Record<string, string> = {
  REQUIRED: 'Заполните поле – без него не опубликовать',
  BEFORE_START: 'Окончание должно быть позже начала',
  MEDIA_MISSING: 'Файла нет в медиатеке – выберите другой',
  MEDIA_NOT_IMAGE: 'Нужна картинка, а не PDF',
  FORMAT: 'Формат: ключ-ГГГГ-ММ-ДД, например privacy-policy-2026-11-10',
  REUSED: 'Текст изменился – укажите новую версию документа',
};

/** Ошибка API → тексты у полей. Ключ – первое звено пути (cover, gallery.0 → поле формы). Общая часть – в `_`. */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return { _: 'Сервер недоступен. Проверьте связь и повторите.' };
  const out: Record<string, string> = {};
  const put = (path: string, text: string) => {
    const key = FIELD_ALIAS[path] ?? FIELD_ALIAS[path.split('.')[0]!] ?? path.split('.')[0]!;
    out[key] ??= text;
  };
  const d = e.details ?? {};
  if (e.code === 'CONTENT_INCOMPLETE') for (const f of (d.fields as Array<{ field: string; code: string }>) ?? []) put(f.field, CODE_TEXT[f.code] ?? f.code);
  else if (e.code === 'MEDIA_ALT_REQUIRED') for (const f of (d.fields as Array<{ field: string }>) ?? []) put(f.field, 'У картинки нет описания (alt) – заполните его в медиатеке');
  else if (e.code === 'CONTENT_INVALID' || e.code === 'VALIDATION_FAILED') for (const i of (d.issues as Array<{ path: string; message: string }>) ?? []) put(i.path, i.message);
  else if (e.code === 'RICH_TEXT_HTML_FORBIDDEN' || e.code === 'RICH_TEXT_TOO_LONG') put(String(d.field ?? '_'), e.message);
  else if (e.code === 'SLUG_TAKEN') put('slug', `Адрес занят. Свободный: ${String(d.suggestion ?? '')}`);
  else if (e.code === 'SLUG_INVALID' || e.code === 'SLUG_RESERVED') put('slug', e.message);
  else if (e.code === 'COMMENT_REQUIRED') put('reason', e.message);
  const general: Record<string, string> = {
    CONTENT_INCOMPLETE: 'Не опубликовано: заполните отмеченные поля.',
    MEDIA_ALT_REQUIRED: 'Не опубликовано: у картинки нет описания (alt).',
    FORBIDDEN: 'Недостаточно прав на это действие.',
    NOT_FOUND: 'Материал не найден или вне вашей зоны.',
    CONTENT_STATUS_CONFLICT: 'Действие недоступно в этом статусе. Обновите страницу.',
  };
  out._ = general[e.code] ?? (Object.keys(out).length ? 'Проверьте отмеченные поля.' : e.message);
  return out;
}
const FIELD_ALIAS: Record<string, string> = { cover: 'coverMediaId', og: 'ogMediaId', rules: 'rulesBody', 'payload.mediaId': 'payload', gallery: 'gallery' };

/** Дата для <input type="datetime-local"> в часовой зоне браузера и обратно – ISO со смещением (z.iso.datetime({ offset: true })). */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | undefined => (v ? new Date(v).toISOString() : undefined);

export function fmtAt(iso: string | null | undefined, tz = 'Asia/Novosibirsk'): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
}

export function scopeLabel(scope: Scope | undefined, branches: BranchRef[]): string {
  if (!scope) return '–';
  if (scope.type === 'network') return 'Вся сеть';
  if (scope.type === 'city') return scope.cityIds.map((id) => branches.find((b) => b.cityId === id)?.cityName ?? 'Город вне зоны').join(', ');
  return scope.branchIds.map((id) => branches.find((b) => b.id === id)?.name ?? 'Филиал вне зоны').join(', ');
}

/** Пустые строки и массивы не отправляем: у полей черновика `.optional()`, пустое – «не заполнено», полнота – при publish. */
export function clean(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = typeof v === 'string' ? v.trim() || undefined : v;
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

export const SECTIONS = [
  { href: '/content/publications', label: 'Публикации' },
  { href: '/content/media', label: 'Медиатека' },
  { href: '/content/games', label: 'Игры' },
  { href: '/content/pages', label: 'Страницы' },
  { href: '/content/home', label: 'Главная' },
] as const;

export function ContentTabs({ path }: { path: string }) {
  return (
    <nav class="yc-tabs yc-ct__tabs" aria-label="Разделы контента">
      {SECTIONS.map((s) => <a class="yc-tabs__link" href={s.href} aria-current={path.startsWith(s.href) ? 'page' : undefined}>{s.label}</a>)}
    </nav>
  );
}

export function Field(props: { id: string; label: string; error?: string | undefined; hint?: string | undefined; children: preact.ComponentChildren }) {
  return (
    <div class="yc-field">
      <label class="yc-field__label" for={props.id}>{props.label}</label>
      {props.children}
      {props.hint && <span class="yc-field__hint" id={`${props.id}-hint`}>{props.hint}</span>}
      {props.error && <span class="yc-field__error" id={`${props.id}-error`} role="alert">{props.error}</span>}
    </div>
  );
}
/** aria-атрибуты поля с ошибкой: invalid и describedby на текст ошибки и подсказку. */
export const aria = (id: string, error?: string, hint?: boolean) => ({
  id,
  'aria-invalid': error ? ('true' as const) : undefined,
  'aria-describedby': [error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined,
});

type Act = 'publish' | 'unpublish' | 'archive';
const ACT: Record<Act, { title: string; button: string; reasonRequired: boolean; text: string }> = {
  publish: { title: 'Опубликовать?', button: 'Опубликовать', reasonRequired: false, text: 'Черновик станет новой версией на сайте. Причина необязательна – она попадёт в историю версий.' },
  unpublish: { title: 'Снять с сайта?', button: 'Снять с сайта', reasonRequired: true, text: 'Страница перестанет показываться посетителям. История версий сохранится.' },
  archive: { title: 'Убрать в архив?', button: 'В архив', reasonRequired: true, text: 'Удаления нет: материал уйдёт в архив, история сохранится.' },
};

/** Панель действий черновика: сохранить, опубликовать, снять, архив – с причиной в окне. Кнопки – по allowed (подсказка; защита на сервере). */
export function DraftActions(props: {
  base: string; // путь сущности API без /draft
  /** Строка запроса после действия (страница города: ?cityId=). */
  query?: string;
  allowed: AllowedAction[];
  status: ContentStatus;
  rowVersion: number;
  busy: boolean;
  dirty: boolean;
  onSave: () => void;
  onDone: (dto: DraftDto, text: string) => void;
  onError: (e: unknown) => void;
  extra?: preact.ComponentChildren;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [act, setAct] = useState<Act>('publish');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (a: Act) => {
    setAct(a);
    setReason('');
    setReasonError('');
    setKey(crypto.randomUUID());
    dialog.current?.showModal();
  };
  const run = async () => {
    const r = reason.trim();
    if (ACT[act].reasonRequired && !r) {
      setReasonError('Укажите причину');
      return;
    }
    setBusy(true);
    try {
      const body = act === 'publish' ? { rowVersion: props.rowVersion, ...(r ? { reason: r } : {}) } : { reason: r };
      const dto = await browserCall<DraftDto>(`${props.base}/${act}${props.query ?? ''}`, { method: 'POST', body, key });
      dialog.current?.close();
      props.onDone(dto, act === 'publish' ? 'Опубликовано: на сайте новая версия.' : act === 'unpublish' ? 'Снято с сайта.' : 'Убрано в архив.');
    } catch (e) {
      dialog.current?.close();
      props.onError(e);
    } finally {
      setBusy(false);
    }
  };
  const a = props.allowed;
  return (
    <div class="yc-ct__actions">
      {a.includes('edit') && <button type="button" class="yc-btn" disabled={props.busy || busy} onClick={props.onSave}>Сохранить черновик</button>}
      {a.includes('publish') && props.status !== 'archived' && (
        <button type="button" class="yc-btn yc-btn--ghost" disabled={props.busy || busy || props.dirty} title={props.dirty ? 'Сначала сохраните черновик' : undefined} onClick={() => open('publish')}>Опубликовать…</button>
      )}
      {a.includes('unpublish') && props.status === 'published' && <button type="button" class="yc-btn yc-btn--ghost" disabled={props.busy || busy} onClick={() => open('unpublish')}>Снять с сайта…</button>}
      {a.includes('archive') && (props.status === 'draft' || props.status === 'unpublished') && <button type="button" class="yc-btn yc-btn--ghost yc-btn--danger-text" disabled={props.busy || busy} onClick={() => open('archive')}>В архив…</button>}
      {props.extra}
      {props.dirty && a.includes('publish') && <span class="yc-field__hint">Есть несохранённые правки: опубликовать можно после сохранения.</span>}
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="ct-act-title">
        <div class="yc-dialog__body">
          <h2 id="ct-act-title">{ACT[act].title}</h2>
          <p>{ACT[act].text}</p>
          <Field id="ct-reason" label={ACT[act].reasonRequired ? 'Причина' : 'Причина (необязательно)'} error={reasonError}>
            <textarea class="yc-input" {...aria('ct-reason', reasonError)} maxlength={2000} rows={3} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
          </Field>
          <div class="yc-dialog__actions">
            <button type="button" class="yc-btn yc-btn--ghost" onClick={() => dialog.current?.close()}>Отмена</button>
            <button type="button" class={`yc-btn${act === 'publish' ? '' : ' yc-btn--danger'}`} disabled={busy} onClick={() => void run()}>{ACT[act].button}</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/** Конфликт версий: черновик поменял другой сотрудник – предлагаем загрузить свежий (правки формы пропадут, об этом говорим прямо). */
export function ConflictNotice(props: { onReload: () => void }) {
  return (
    <div class="yc-alert yc-alert--error yc-ct__conflict" role="alert">
      <p>Черновик уже изменил другой сотрудник – ваши правки не сохранены.</p>
      <button type="button" class="yc-btn yc-btn--ghost" onClick={props.onReload}>Обновить черновик</button>
      <span class="yc-field__hint">Ваши несохранённые правки пропадут – скопируйте нужный текст перед обновлением.</span>
    </div>
  );
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Сервер недоступен. Проверьте связь и повторите.');
