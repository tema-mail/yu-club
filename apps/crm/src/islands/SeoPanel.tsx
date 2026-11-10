// S4-89: панель SEO в редакторе (K23 §3–§5, K11 №236–238): адрес (слаг) с проверкой занятости и истории, подсказка из заголовка,
// предупреждение «старый адрес будет вести на новый» при смене адреса опубликованного; title, description, H1 со счётчиками
// (title > 70 – предупреждение, > 120 – ошибка; description > 160 / > 300; H1 ≤ 90), флаг индексации, вид сниппета. Поля – часть черновика:
// сайт меняется только публикацией. Адрес строится тем же кодом, что у сайта (packages/contracts/src/paths.ts).
import { useEffect, useState } from 'preact/hooks';
import { gamePath, publicationPath, type PublicationType } from '../../../../packages/contracts/src/paths.ts';
import { browserCall } from '../lib/api.ts';
import { aria, Field } from '../lib/content.tsx';

export interface SeoValue { slug: string; seoTitle: string; seoDescription: string; h1: string; indexable?: boolean | undefined }
export interface SeoPanelProps {
  entityType: 'publication' | 'game';
  /** Тип публикации или направление игры – родитель слага. */
  parent: string;
  entityId: string | null;
  /** Адрес живой версии: смена у опубликованного пишет историю и 301. */
  liveSlug: string | null;
  published: boolean;
  title: string;
  lead: string;
  value: SeoValue;
  onChange: (v: SeoValue) => void;
  errors: Record<string, string>;
  disabled: boolean;
  /** Шаблон title сайта (lib/seo.ts K23 §4): у игры « – где поиграть в Ю-Клуб», по умолчанию « – Ю-Клуб». */
  titleSuffix?: string;
  /** Откуда берётся описание, если поле пусто: «анонс» у публикаций, «коротко» у игры. */
  descriptionFrom?: string;
  /** Адрес задан картой сайта (страницы /about/, /rules/…, баннер главной «/»): поля адреса нет, только мета. */
  fixedPath?: string;
}
export const SEO_LIMITS = { seoTitle: { warn: 70, max: 120 }, seoDescription: { warn: 160, max: 300 }, h1: { warn: 90, max: 90 } } as const;
/** Ошибки длины до отправки: сервер отрежет то же (common.ts seoShape). */
export function seoLengthErrors(v: SeoValue): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, l] of Object.entries(SEO_LIMITS)) if ((v[k as keyof typeof SEO_LIMITS] ?? '').length > l.max) out[k] = `Не длиннее ${l.max} знаков`;
  return out;
}

function Counter({ id, n, warn, max }: { id: string; n: number; warn: number; max: number }) {
  const cls = n > max ? 'yc-ct__count yc-ct__count--error' : n > warn ? 'yc-ct__count yc-ct__count--warn' : 'yc-ct__count';
  const text = n > max ? `${n} из ${max} – слишком длинно, не сохранится` : n > warn ? `${n} – длиннее ${warn}: поисковик обрежет` : `${n} из ${warn}`;
  return <span class={cls} id={`${id}-count`} aria-live="polite">{text}</span>;
}

type Check = { ok: boolean; code?: string; suggestion?: string } | null;

export default function SeoPanel(props: SeoPanelProps) {
  const v = props.value;
  const [check, setCheck] = useState<Check>(null);
  const [history, setHistory] = useState<Array<{ oldSlug: string; createdAt: string }>>([]);
  const set = (k: keyof SeoValue, val: string | boolean) => props.onChange({ ...v, [k]: val });
  const path = props.fixedPath ?? (v.slug ? (props.entityType === 'publication' ? publicationPath(props.parent as PublicationType, v.slug) : gamePath(props.parent as 'pc', v.slug)) : '');

  useEffect(() => {
    if (!props.entityId || props.fixedPath) return;
    browserCall<{ items: Array<{ oldSlug: string; createdAt: string }> }>(`/seo/history?entityType=${props.entityType}&entityId=${props.entityId}`).then((r) => setHistory(r.items)).catch(() => setHistory([]));
  }, [props.entityId]);

  const verify = async (slug = v.slug) => {
    if (!slug) return setCheck(null);
    const p = new URLSearchParams({ entityType: props.entityType, parent: props.parent, slug });
    if (props.entityId) p.set('excludeId', props.entityId);
    try {
      setCheck(await browserCall<Check>(`/content/slug-check?${p}`));
    } catch {
      setCheck(null);
    }
  };
  const suggest = async () => {
    if (!props.title.trim()) return;
    const r = await browserCall<{ slug: string }>(`/content/slug-suggest?type=${props.entityType}&title=${encodeURIComponent(props.title.trim())}`);
    set('slug', r.slug);
    void verify(r.slug);
  };

  const slugMsg = props.errors.slug ?? (check && !check.ok ? (check.code === 'SLUG_TAKEN' ? `Адрес занят. Свободный: ${check.suggestion ?? ''}` : 'Только латиница в нижнем регистре, цифры и дефис, до 90 знаков') : undefined);
  const movedFrom = props.published && props.liveSlug && v.slug && v.slug !== props.liveSlug ? props.liveSlug : null;
  const suffix = props.titleSuffix ?? ' – Ю-Клуб';
  const from = props.descriptionFrom ?? 'анонс';
  const snippetTitle = v.seoTitle.trim() || (props.title.trim() ? `${props.title.trim()}${suffix}` : 'Заголовок страницы');
  const snippetDesc = v.seoDescription.trim() || props.lead.trim() || `Описание появится из поля «${from}».`;

  return (
    <section class="yc-ct__box" aria-labelledby="seo-title-h" data-testid="seo-panel">
      <h2 id="seo-title-h">{props.fixedPath ? 'Поиск' : 'Поиск и адрес'}</h2>
      {!props.fixedPath && (<>
      <Field id="seo-slug" label="Адрес страницы" error={slugMsg} hint="Английские слова по смыслу: латиница, цифры, дефис.">
        <input {...aria('seo-slug', slugMsg, true)} class="yc-input" maxLength={200} value={v.slug} disabled={props.disabled} onInput={(e) => { set('slug', e.currentTarget.value.trim().toLowerCase()); setCheck(null); }} onBlur={() => void verify()} />
      </Field>
      <div class="yc-ct__pick">
        <button type="button" class="yc-btn yc-btn--ghost" disabled={props.disabled || !props.title.trim()} onClick={() => void suggest()}>Подставить из заголовка</button>
        {check && check.code === 'SLUG_TAKEN' && check.suggestion && <button type="button" class="yc-btn yc-btn--ghost" disabled={props.disabled} onClick={() => { set('slug', check.suggestion!); setCheck({ ok: true }); }}>Взять {check.suggestion}</button>}
      </div>
      {check?.ok && check.code === 'SLUG_IN_HISTORY' && <p class="yc-ct__warn" role="status">Этот адрес раньше был у другого материала: ссылки, которые вели туда, начнут вести сюда.</p>}
      {movedFrom && <p class="yc-ct__warn" role="status" data-testid="seo-moved">Адрес опубликованного материала меняется: старый адрес /{movedFrom}/ будет вести на новый (301) после публикации.</p>}
      {history.length > 0 && <p class="yc-ct__muted">Прежние адреса (ведут сюда): {history.map((h) => h.oldSlug).join(', ')}</p>}
      </>)}
      <Field id="seo-seoTitle" label="Title" error={props.errors.seoTitle} hint={`Пусто – «Заголовок${suffix}».`}>
        <input {...aria('seo-seoTitle', props.errors.seoTitle, true)} class="yc-input" value={v.seoTitle} disabled={props.disabled} onInput={(e) => set('seoTitle', e.currentTarget.value)} />
      </Field>
      <Counter id="seo-seoTitle" n={v.seoTitle.length} {...SEO_LIMITS.seoTitle} />
      <Field id="seo-seoDescription" label="Description" error={props.errors.seoDescription} hint={`Пусто – ${from}.`}>
        <textarea {...aria('seo-seoDescription', props.errors.seoDescription, true)} class="yc-input" rows={3} value={v.seoDescription} disabled={props.disabled} onInput={(e) => set('seoDescription', e.currentTarget.value)} />
      </Field>
      <Counter id="seo-seoDescription" n={v.seoDescription.length} {...SEO_LIMITS.seoDescription} />
      <Field id="seo-h1" label="H1" error={props.errors.h1} hint="Пусто – заголовок материала.">
        <input {...aria('seo-h1', props.errors.h1, true)} class="yc-input" value={v.h1} disabled={props.disabled} onInput={(e) => set('h1', e.currentTarget.value)} />
      </Field>
      <Counter id="seo-h1" n={v.h1.length} warn={90} max={90} />
      {v.indexable !== undefined && (
        <label class="yc-check"><input type="checkbox" checked={v.indexable} disabled={props.disabled} onChange={(e) => set('indexable', e.currentTarget.checked)} /> Показывать в поиске (индексировать)</label>
      )}
      <div class="yc-ct__snippet" aria-label="Так страница может выглядеть в поиске" data-testid="seo-snippet">
        <span class="yc-ct__snippet-title">{snippetTitle.length > 70 ? `${snippetTitle.slice(0, 69)}…` : snippetTitle}</span>
        <span class="yc-ct__snippet-url">yu-club.ru{path || '/…/'}</span>
        <span class="yc-ct__snippet-desc">{snippetDesc.length > 160 ? `${snippetDesc.slice(0, 159)}…` : snippetDesc}</span>
        {v.indexable === false && <span class="yc-ct__warn">Не индексируется: в поиске страницы не будет.</span>}
      </div>
    </section>
  );
}
