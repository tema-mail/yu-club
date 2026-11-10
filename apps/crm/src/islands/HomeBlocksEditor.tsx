// S4-87: блоки главной (K11 №228; 12 §5): фиксированные типы, содержимое по схеме типа, уровень сеть или город (городской опубликованный
// подменяет сетевой). Порядок – перетаскиванием и кнопками «Выше/Ниже» (доступно с клавиатуры), сохраняется сразу и не версионируется.
// Сеть правит Владелец (content.network.manage), город – Директор города (content.publish по cityId).
// У баннера hero – SEO главной (title, description, H1; адрес «/» фиксирован, K23 §4); у каждого блока – история версий и откат (K22 §3).
import { useEffect, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { DraftActions, errorText, fieldErrors, STATUS_BADGE, STATUS_LABEL, type DraftDto } from '../lib/content.tsx';
import { RATIO_HINT } from './MediaLibrary.tsx';
import MediaPicker from './MediaPicker.tsx';
import SeoPanel, { seoLengthErrors, type SeoValue } from './SeoPanel.tsx';
import VersionHistory from './VersionHistory.tsx';

type BlockType = 'hero' | 'about' | 'directions' | 'advantages' | 'promo_strip' | 'cta';
interface Block extends DraftDto { id: string; blockType: BlockType; cityId: string | null; sortOrder: number }
export const BLOCK_LABEL: Record<BlockType, string> = { hero: 'Первый экран', about: 'О клубе', directions: 'Направления', advantages: 'Преимущества', promo_strip: 'Полоса акции', cta: 'Призыв к записи' };
const TYPES = Object.keys(BLOCK_LABEL) as BlockType[];
type F = { name: string; label: string; max?: number; area?: boolean; hint?: string };
/** Поля содержимого по типу (blocks.ts): списки – строками «заголовок | текст» (у направлений – «pc | заголовок | текст»). */
const FIELDS: Record<BlockType, F[]> = {
  hero: [{ name: 'title', label: 'Заголовок', max: 120 }, { name: 'subtitle', label: 'Подзаголовок', max: 300 }, { name: 'ctaLabel', label: 'Текст кнопки', max: 60 }, { name: 'ctaUrl', label: 'Ссылка кнопки', max: 500, hint: 'Путь сайта, например /booking/.' }],
  about: [{ name: 'title', label: 'Заголовок', max: 120 }, { name: 'body', label: 'Текст', area: true, max: 5000 }],
  directions: [{ name: 'items', label: 'Направления', area: true, hint: 'По одному в строке: pc | Заголовок | Текст (pc, vr или playstation, не больше трёх).' }],
  advantages: [{ name: 'title', label: 'Заголовок', max: 120 }, { name: 'items', label: 'Преимущества', area: true, hint: 'По одному в строке: Заголовок | Текст.' }],
  promo_strip: [{ name: 'text', label: 'Текст полосы', max: 200 }, { name: 'url', label: 'Ссылка', max: 500, hint: 'Путь сайта.' }],
  cta: [{ name: 'title', label: 'Заголовок', max: 120 }, { name: 'text', label: 'Текст', max: 300 }, { name: 'label', label: 'Текст кнопки', max: 60 }, { name: 'url', label: 'Ссылка', max: 500 }],
};

function toForm(type: BlockType, payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS[type]) {
    const v = payload[f.name];
    out[f.name] = f.name === 'items' && Array.isArray(v) ? (v as Array<Record<string, string>>).map((it) => [type === 'directions' ? it.direction : null, it.title, it.text ?? ''].filter((x) => x !== null).join(' | ')).join('\n') : String(v ?? '');
  }
  out.mediaId = String(payload.mediaId ?? '');
  return out;
}
function toPayload(type: BlockType, form: Record<string, string>, old: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const f of FIELDS[type]) {
    const v = (form[f.name] ?? '').trim();
    if (f.name === 'items') {
      const prev = (old.items as Array<Record<string, unknown>> | undefined) ?? [];
      p.items = v.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x.some(Boolean)).map((x, i) => {
        const it: Record<string, unknown> = type === 'directions' ? { direction: x[0], title: x[1] ?? '', ...(x[2] ? { text: x[2] } : {}) } : { title: x[0] ?? '', ...(x[1] ? { text: x[1] } : {}) };
        if (prev[i]?.mediaId) it.mediaId = prev[i]!.mediaId;
        return it;
      });
    } else if (v) p[f.name] = v;
  }
  if (type === 'hero' && form.mediaId) p.mediaId = form.mediaId;
  return p;
}

const seoOf = (d: Record<string, unknown>): SeoValue => ({ slug: '', seoTitle: String(d.seoTitle ?? ''), seoDescription: String(d.seoDescription ?? ''), h1: String(d.h1 ?? '') });

/** История версий блока – по кнопке: у каждого блока своя, монтируется одна на карточку (id полей окна не повторяются). */
function BlockHistory(props: { id: string; canRollback: boolean }) {
  const [open, setOpen] = useState(false);
  return open
    ? <VersionHistory versionsPath={`/content/home-blocks/${props.id}/versions`} draftPath={`/content/home-blocks/${props.id}/draft`} actionBase={`/content/home-blocks/${props.id}`} canRollback={props.canRollback} timezone="Asia/Novosibirsk" />
    : <button type="button" class="yc-btn yc-btn--ghost" onClick={() => setOpen(true)}>История версий</button>;
}

function BlockCard(props: { block: Block | null; type: BlockType; cityId: string | null; canEdit: boolean; index: number; count: number; onMove: (dir: -1 | 1) => void; onChanged: () => void }) {
  const { block, type } = props;
  const payload = ((block?.draft.payload ?? {}) as Record<string, unknown>);
  const [form, setForm] = useState(toForm(type, payload));
  const [seo, setSeo] = useState<SeoValue>(seoOf(block?.draft ?? {}));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const save = async () => {
    setErrors({});
    setMsg(null);
    const long = type === 'hero' ? seoLengthErrors(seo) : {};
    if (Object.keys(long).length) return setErrors(long);
    setBusy(true);
    try {
      const meta = type === 'hero' ? { seoTitle: seo.seoTitle.trim() || undefined, seoDescription: seo.seoDescription.trim() || undefined, h1: seo.h1.trim() || undefined } : {};
      const draft: Record<string, unknown> = { ...(block?.draft ?? {}), blockType: type, payload: toPayload(type, form, payload), ...meta };
      for (const k of Object.keys(meta) as Array<keyof typeof meta>) if (meta[k] === undefined) delete draft[k];
      await browserCall('/content/home-blocks', { method: 'PUT', body: { blockType: type, cityId: props.cityId, ...(block ? { rowVersion: block.rowVersion } : {}), draft } });
      setDirty(false);
      setMsg({ ok: true, text: block ? 'Черновик блока сохранён.' : 'Блок создан черновиком.' });
      props.onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setMsg({ ok: false, text: 'Блок уже изменил другой сотрудник – обновите страницу.' });
      else {
        const fe = fieldErrors(e);
        const mapped: Record<string, string> = {};
        for (const [k, v] of Object.entries(fe)) mapped[k === 'payload' ? 'payload' : k] = v;
        setErrors(mapped);
        setMsg({ ok: false, text: `${fe._ ?? ''} ${Object.entries(fe).filter(([k]) => k !== '_').map(([, v]) => v).join('; ')}`.trim() });
      }
    } finally {
      setBusy(false);
    }
  };
  const id = (n: string) => `blk-${type}-${n}`;
  return (
    <div class="yc-ct__block-body">
      <fieldset class="yc-ct__fieldset" disabled={!props.canEdit || busy}>
        {FIELDS[type].map((f) => (
          <div class="yc-field">
            <label class="yc-field__label" for={id(f.name)}>{f.label}</label>
            {f.area ? <textarea id={id(f.name)} class="yc-input" rows={4} maxLength={f.max} value={form[f.name]} onInput={(e) => { setForm({ ...form, [f.name]: e.currentTarget.value }); setDirty(true); }} />
              : <input id={id(f.name)} class="yc-input" maxLength={f.max} value={form[f.name]} onInput={(e) => { setForm({ ...form, [f.name]: e.currentTarget.value }); setDirty(true); }} />}
            {f.hint && <span class="yc-field__hint">{f.hint}</span>}
          </div>
        ))}
        {type === 'hero' && <MediaPicker id={id('media')} label="Баннер" value={form.mediaId ?? ''} hint={RATIO_HINT.banner} disabled={!props.canEdit || busy} onChange={(v) => { setForm({ ...form, mediaId: v }); setDirty(true); }} />}
      </fieldset>
      {type === 'hero' && (
        <SeoPanel entityType="publication" parent="" entityId={block?.id ?? null} liveSlug={null} published={block?.status === 'published'} title="Ю-Клуб – компьютерный клуб: ПК, VR, PlayStation" lead={form.subtitle ?? ''}
          titleSuffix="" descriptionFrom="текст «О клубе»" fixedPath="/" value={seo} onChange={(v) => { setSeo(v); setDirty(true); }} errors={errors} disabled={!props.canEdit || busy} />
      )}
      <p class={`yc-alert ${msg ? (msg.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">{msg?.text ?? ''}</p>
      {block ? (
        <DraftActions base={`/content/home-blocks/${block.id}`} allowed={props.canEdit ? ['edit', 'publish', 'rollback', ...(block.status === 'published' ? (['unpublish'] as const) : [])] : []} status={block.status}
          rowVersion={block.rowVersion} busy={busy} dirty={dirty} onSave={() => void save()} onDone={(_d, t) => { setMsg({ ok: true, text: t }); props.onChanged(); }}
          onError={(e) => { const fe = fieldErrors(e); setErrors(fe); setMsg({ ok: false, text: fe._ ?? errorText(e) }); }} />
      ) : props.canEdit && <button type="button" class="yc-btn" disabled={busy} onClick={() => void save()}>Создать блок</button>}
      {Object.keys(errors).length > 0 && <span class="yc-ct__muted">Проверьте поля блока.</span>}
      {block && <BlockHistory id={block.id} canRollback={props.canEdit} />}
    </div>
  );
}

export default function HomeBlocksEditor(props: { cityId: string | null; canEdit: boolean }) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState('');
  const [orderMsg, setOrderMsg] = useState('');
  const [reload, setReload] = useState(0);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const q = props.cityId ? `?cityId=${encodeURIComponent(props.cityId)}` : '';
  useEffect(() => {
    browserCall<{ items: Block[] }>(`/content/home-blocks${q}`).then((r) => setBlocks(r.items)).catch((e: unknown) => setError(errorText(e)));
  }, [reload]);

  const saveOrder = async (ids: string[]) => {
    const prev = blocks;
    setBlocks(ids.map((id) => blocks!.find((b) => b.id === id)!));
    try {
      await browserCall('/content/home-blocks/order', { method: 'PUT', body: { cityId: props.cityId, ids } });
      setOrderMsg('Порядок сохранён – на сайте он меняется сразу у опубликованных блоков.');
    } catch (e) {
      setBlocks(prev);
      setOrderMsg(`Порядок не сохранён: ${errorText(e)}`);
    }
  };
  const move = (from: number, to: number) => {
    if (!blocks || to < 0 || to >= blocks.length) return;
    const ids = blocks.map((b) => b.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    void saveOrder(ids);
  };

  if (error) return <p class="yc-alert yc-alert--error" role="alert">{error}</p>;
  if (!blocks) return <p class="yc-ct__muted">Загрузка…</p>;
  const missing = TYPES.filter((t) => !blocks.some((b) => b.blockType === t));
  return (
    <div class="yc-ct__main">
      <p class="yc-alert" role="status" aria-live="polite" data-testid="order-msg">{orderMsg}</p>
      <ol class="yc-ct__blocks" data-testid="home-blocks">
        {blocks.map((b, i) => (
          <li key={b.id} class="yc-ct__block" data-testid={`block-${b.blockType}`} data-drag={over === b.id ? 'over' : undefined} draggable={props.canEdit}
            onDragStart={(e) => { setDrag(b.id); e.dataTransfer?.setData('text/plain', b.id); }} onDragOver={(e) => { e.preventDefault(); setOver(b.id); }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (drag && drag !== b.id) move(blocks.findIndex((x) => x.id === drag), i); setDrag(null); }}>
            <div class="yc-ct__block-head">
              {props.canEdit && <span class="yc-ct__grip" aria-hidden="true">⠿</span>}
              <h2>{i + 1}. {BLOCK_LABEL[b.blockType]}</h2>
              <span class={`yc-badge yc-badge--${STATUS_BADGE[b.status]}`}>{STATUS_LABEL[b.status]}</span>
              {props.canEdit && (
                <>
                  <button type="button" class="yc-btn yc-btn--ghost" disabled={i === 0} aria-label={`Выше: ${BLOCK_LABEL[b.blockType]}`} onClick={() => move(i, i - 1)}>Выше</button>
                  <button type="button" class="yc-btn yc-btn--ghost" disabled={i === blocks.length - 1} aria-label={`Ниже: ${BLOCK_LABEL[b.blockType]}`} onClick={() => move(i, i + 1)}>Ниже</button>
                </>
              )}
            </div>
            <details>
              <summary>Изменить содержимое</summary>
              <BlockCard block={b} type={b.blockType} cityId={props.cityId} canEdit={props.canEdit} index={i} count={blocks.length} onMove={(d) => move(i, i + d)} onChanged={() => setReload((n) => n + 1)} />
            </details>
          </li>
        ))}
      </ol>
      {props.canEdit && missing.length > 0 && (
        <section class="yc-ct__box" aria-labelledby="blk-new">
          <h2 id="blk-new">Добавить блок</h2>
          {missing.map((t) => (
            <details><summary>{BLOCK_LABEL[t]}</summary><BlockCard block={null} type={t} cityId={props.cityId} canEdit index={0} count={0} onMove={() => undefined} onChanged={() => setReload((n) => n + 1)} /></details>
          ))}
        </section>
      )}
    </div>
  );
}
