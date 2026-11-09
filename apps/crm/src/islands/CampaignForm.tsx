// Форма сообщения и карточка рассылки (S4-81; 09 §7.2–§7.5, §12.1, K21 §5–§6, K11 №202–207). Категория обязательна: пока она
// не выбрана, кнопок проверки и отправки нет. Варианты – по правам из /me: у Администратора только сервисное по записи или
// клиенту записи, без рекламы и группы (K21 §10). Черновик – POST с одним ключом на попытку (двойной клик – одна кампания),
// правка – PATCH по rowVersion. «Проверить аудиторию» сохраняет черновик и зовёт №205; отправка – только после свежего
// предпросмотра, через второе подтверждение с числом адресатов (AudiencePreview). Не черновик – карточка: счётчики, история,
// отмена с причиной (оставшееся не уйдёт, ушедшее не отзывается).
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import {
  CAMPAIGN_BADGE, CAMPAIGN_STATUS, CATEGORY_LABEL, DIRECTION_LABEL, PLACEHOLDERS, describeAudience, fmtAt, notificationError, zonedDayStart,
  type Audience, type AudiencePreviewDto, type CampaignCategory, type CampaignDetail, type CampaignDto, type SegmentV1, type TemplateDto,
} from '../lib/notifications.ts';
import AudiencePreview from './AudiencePreview.tsx';

type Kind = 'booking' | 'client' | 'segment';
interface Branch { id: string; name: string; cityId: string; cityName: string; timezone: string }
export interface CampaignFormProps {
  initial: CampaignDetail | null;
  prefill: { clientId: string; bookingId: string };
  branches: Branch[];
  timezone: string;
  templates: TemplateDto[];
  staffNames: Record<string, string>;
  meId: string;
  can: { service: boolean; marketing: boolean; mass: boolean; network: boolean };
}
interface Draft {
  category: '' | CampaignCategory; kind: Kind; bookingId: string; clientId: string; branchId: string; area: string;
  notVisitedSince: string; visitedFrom: string; visitedTo: string; minVisits: string; upcoming: '' | 'yes' | 'no'; directions: Array<'pc' | 'vr' | 'ps'>;
  purpose: string; title: string; body: string; url: string; plannedAt: string; push: boolean; erid: string; advertiserNote: string; templateId: string;
}

/** ISO → «YYYY-MM-DDTHH:mm» в зоне филиала и обратно (поле datetime-local). */
function toLocal(v: string | null, tz: string): string {
  if (!v) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(v));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
function fromLocal(v: string, tz: string): string {
  const [day = '', hm = '00:00'] = v.split('T');
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return new Date(Date.parse(zonedDayStart(day, tz)) + h * 3_600_000 + m * 60_000).toISOString();
}

function fromCampaign(c: CampaignDto | null, prefill: CampaignFormProps['prefill'], tz: string): Draft {
  const a = c?.audience;
  const seg: SegmentV1 | null = a?.kind === 'segment' ? a.segment : null;
  const area = !seg ? '' : 'network' in seg.area ? 'network' : 'cityIds' in seg.area ? `city:${seg.area.cityIds[0] ?? ''}` : `branch:${seg.area.branchIds[0] ?? ''}`;
  return {
    category: c?.category ?? '', kind: a?.kind ?? (prefill.bookingId || !prefill.clientId ? 'booking' : 'client'),
    bookingId: a && a.kind !== 'segment' ? (a.bookingId ?? '') : prefill.bookingId, clientId: a?.kind === 'client' ? a.clientId : prefill.clientId,
    branchId: a?.kind === 'client' ? (a.branchId ?? '') : '', area,
    notVisitedSince: seg?.notVisitedSince ?? '', visitedFrom: seg?.visitedBetween?.from ?? '', visitedTo: seg?.visitedBetween?.to ?? '',
    minVisits: seg?.minVisits ? String(seg.minVisits) : '', upcoming: seg?.hasUpcomingBooking === undefined ? '' : seg.hasUpcomingBooking ? 'yes' : 'no', directions: seg?.resourceTypes ?? [],
    purpose: c?.purpose ?? '', title: c?.title ?? '', body: c?.body ?? '', url: c?.url ?? '', plannedAt: toLocal(c?.plannedAt ?? null, tz), push: c?.push ?? true,
    erid: c?.erid ?? '', advertiserNote: c?.advertiserNote ?? '', templateId: c?.templateId ?? '',
  };
}

const ACTION_LABEL: Record<string, string> = {
  'notification.campaign_created': 'Создан черновик', 'notification.campaign_updated': 'Черновик изменён', 'notification.campaign_confirmed': 'Отправка подтверждена',
  'notification.campaign_cancelled': 'Рассылка отменена',
};

export default function CampaignForm({ initial, prefill, branches, timezone, templates, staffNames, meId, can }: CampaignFormProps) {
  const [campaign, setCampaign] = useState<CampaignDto | null>(initial);
  const [d, setD] = useState<Draft>(() => fromCampaign(initial, prefill, timezone));
  const [dirty, setDirty] = useState(initial === null);
  const [preview, setPreview] = useState<AudiencePreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [found, setFound] = useState<Array<{ id: string; firstName: string | null; lastName: string | null; phoneMasked: string }>>([]);
  const [q, setQ] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const createKey = useRef(crypto.randomUUID());
  const cancelKey = useRef('');
  const cancelDlg = useRef<HTMLDialogElement>(null);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? 'Филиал';
  const cityName = (id: string) => branches.find((b) => b.cityId === id)?.cityName ?? 'Город';
  const cities = [...new Map(branches.map((b) => [b.cityId, b.cityName])).entries()];
  const author = (id: string | null) => (!id ? 'Система' : id === meId ? 'Вы' : (staffNames[id] ?? 'Сотрудник'));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setDirty(true);
    setPreview(null);
    setFieldErr((f) => ({ ...f, [k]: '' }));
  };
  const kinds: Array<[Kind, string]> = [
    ['booking', 'Клиент записи'],
    ['client', 'Один клиент'],
    ...(d.category === 'marketing' && can.mass ? [['segment', 'Группа клиентов'] as [Kind, string]] : []),
  ];
  const kind: Kind = kinds.some(([k]) => k === d.kind) ? d.kind : 'booking';

  const audience = (): Audience => {
    if (kind === 'booking') return { kind: 'booking', bookingId: d.bookingId.trim() };
    if (kind === 'client') return { kind: 'client', clientId: d.clientId.trim(), ...(d.bookingId.trim() ? { bookingId: d.bookingId.trim() } : {}), ...(d.branchId ? { branchId: d.branchId } : {}) };
    const [type, id = ''] = d.area.split(':');
    const s: SegmentV1 = { v: 1, area: type === 'network' ? { network: true } : type === 'city' ? { cityIds: [id] } : { branchIds: [id] } };
    if (d.notVisitedSince) s.notVisitedSince = d.notVisitedSince;
    if (d.visitedFrom || d.visitedTo) s.visitedBetween = { from: d.visitedFrom, to: d.visitedTo };
    if (d.minVisits) s.minVisits = Number(d.minVisits);
    if (d.upcoming) s.hasUpcomingBooking = d.upcoming === 'yes';
    if (d.directions.length) s.resourceTypes = d.directions;
    return { kind: 'segment', segment: s };
  };
  const tz = branches.find((b) => b.id === (kind === 'segment' ? d.area.split(':')[1] : d.branchId))?.timezone ?? timezone;

  /** Проверки до сервера: чтобы ошибка стояла у поля, а не только общим текстом. */
  const localCheck = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!d.category) e.category = 'Выберите категорию.';
    if (kind === 'booking' && !d.bookingId.trim()) e.bookingId = 'Укажите запись клиента.';
    if (kind === 'client' && !d.clientId.trim()) e.clientId = 'Найдите и выберите клиента.';
    if (kind === 'client' && d.category === 'service' && !d.bookingId.trim()) e.bookingId = 'Сервисное – только по записи клиента.';
    if (kind === 'client' && d.category === 'marketing' && !can.network && !d.branchId) e.branchId = 'Выберите филиал, где клиент бывал.';
    if (kind === 'segment' && !d.area) e.area = 'Выберите, кому: филиал, город или сеть.';
    if (kind !== 'segment' && !d.purpose.trim()) e.purpose = 'Укажите назначение личного сообщения.';
    if (!d.title.trim()) e.title = 'Заполните заголовок.';
    if (!d.body.trim()) e.body = 'Заполните текст.';
    if (d.category === 'marketing' && !d.erid.trim()) e.erid = 'Для рекламы нужен erid.';
    return e;
  };
  const serverField = (e: unknown): Record<string, string> => {
    if (!(e instanceof ApiError)) return {};
    const msg = notificationError(e);
    const byCode: Record<string, string> = {
      TEMPLATE_PLACEHOLDER_UNKNOWN: 'body', PLANNED_AT_OUT_OF_RANGE: 'plannedAt', MARKETING_ERID_REQUIRED: 'erid', SERVICE_NEEDS_SUBJECT: 'bookingId', SEGMENT_INVALID: 'area',
      CATEGORY_REQUIRED: e.details?.field === 'purpose' ? 'purpose' : 'category',
    };
    if (byCode[e.code]) return { [byCode[e.code]!]: msg };
    const issues = (e.details?.issues as Array<{ path: string }> | undefined) ?? [];
    const out: Record<string, string> = {};
    for (const i of issues) out[i.path.split('.').at(-1) ?? 'form'] = 'Проверьте значение.';
    return out;
  };

  const save = async (): Promise<CampaignDto | null> => {
    const local = localCheck();
    if (Object.values(local).some(Boolean)) {
      setFieldErr(local);
      setError('Проверьте выделенные поля.');
      return null;
    }
    if (campaign && !dirty) return campaign;
    const body = {
      category: d.category, audience: audience(), title: d.title.trim(), body: d.body.trim(), push: d.push,
      ...(kind !== 'segment' ? { purpose: d.purpose.trim() } : {}), url: d.url.trim() || null, plannedAt: d.plannedAt ? fromLocal(d.plannedAt, tz) : null,
      ...(d.category === 'marketing' ? { erid: d.erid.trim() || null, advertiserNote: d.advertiserNote.trim() || null } : {}),
    };
    const saved = campaign
      ? await browserCall<CampaignDto>(`/notifications/campaigns/${encodeURIComponent(campaign.id)}`, { method: 'PATCH', body: { ...body, rowVersion: campaign.rowVersion } })
      : await browserCall<CampaignDto>('/notifications/campaigns', { method: 'POST', body: d.templateId ? { ...body, templateId: d.templateId } : body, key: createKey.current });
    setCampaign(saved);
    setDirty(false);
    if (!campaign) history.replaceState(null, '', `/notifications/campaigns/${saved.id}`);
    return saved;
  };
  const lock = useRef(false);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return; // двойной клик: второй вызов не уходит, пока идёт первый
    lock.current = true;
    setBusy(true);
    setError('');
    setFieldErr({});
    try {
      await fn();
    } catch (e) {
      setFieldErr(serverField(e));
      setError(notificationError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const loadPreview = async (id: string) => {
    const p = await browserCall<AudiencePreviewDto>(`/notifications/campaigns/${encodeURIComponent(id)}/preview`, { method: 'POST' });
    setPreview(p);
    return p;
  };
  const check = () => run(async () => {
    const c = await save();
    if (c) await loadPreview(c.id);
  });
  const saveOnly = () => run(async () => {
    if (await save()) setError('');
  });
  const send = async (expectedTotal: number, key: string) => {
    const c = campaign!;
    await browserCall<CampaignDto>(`/notifications/campaigns/${encodeURIComponent(c.id)}/confirm`, { method: 'POST', body: { rowVersion: c.rowVersion, expectedTotal }, key });
    location.assign(`/notifications/campaigns/${c.id}`);
  };
  const search = () => run(async () => {
    const r = await browserCall<{ items: typeof found }>(`/clients?q=${encodeURIComponent(q.trim())}&limit=10`);
    setFound(r.items);
    if (!r.items.length) setError('Клиент не найден. Попробуйте полный номер телефона.');
  });
  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    setD((x) => ({ ...x, templateId: id, ...(t ? { category: t.category, title: t.title, body: t.body } : {}) }));
    setDirty(true);
    setPreview(null);
  };
  const cancel = async (e: Event) => {
    e.preventDefault();
    if (!cancelReason.trim()) return setError('Укажите причину отмены.');
    await run(async () => {
      const c = await browserCall<CampaignDto>(`/notifications/campaigns/${encodeURIComponent(campaign!.id)}/cancel`, { method: 'POST', body: { reason: cancelReason.trim() }, key: cancelKey.current });
      cancelDlg.current?.close();
      setCampaign(c);
      location.reload();
    });
  };

  const err = (k: string) => fieldErr[k] ? <span class="yc-field__error" id={`cf-${k}-err`}>{fieldErr[k]}</span> : null;
  const inv = (k: string) => (fieldErr[k] ? { 'aria-invalid': 'true' as const, 'aria-describedby': `cf-${k}-err` } : {});
  const describe = (a: Audience) => describeAudience(a, { branch: branchName, city: cityName });

  // ---- карточка подтверждённой или отменённой рассылки
  if (campaign && campaign.status !== 'draft') {
    const detail = initial && initial.id === campaign.id ? initial : null;
    const cTz = campaign.areaType === 'branch' ? (branches.find((b) => b.id === campaign.areaIds[0])?.timezone ?? timezone) : timezone;
    const canCancel = !['done', 'cancelled'].includes(campaign.status) && (campaign.category === 'marketing' ? can.marketing : can.service) && (campaign.audience.kind !== 'segment' || can.mass);
    return (
      <div class="yc-list" data-testid="campaign-card">
        <section class="yc-panel" aria-labelledby="cc-title">
          <h2 id="cc-title">{campaign.title} <span class={`yc-badge yc-badge--${CAMPAIGN_BADGE[campaign.status]}`} data-testid="campaign-status">{CAMPAIGN_STATUS[campaign.status]}</span></h2>
          <dl class="yc-props">
            <dt>Категория</dt><dd>{CATEGORY_LABEL[campaign.category]}</dd>
            {campaign.purpose && <><dt>Назначение</dt><dd>{campaign.purpose}</dd></>}
            <dt>Текст</dt><dd>{campaign.body}</dd>
            <dt>Аудитория</dt><dd>{describe(campaign.audience)}</dd>
            <dt>Адресатов</dt><dd>{campaign.total ?? '–'}</dd>
            <dt>Автор</dt><dd>{author(campaign.createdBy)}, {fmtAt(campaign.createdAt, cTz)}</dd>
            <dt>Подтвердил</dt><dd>{campaign.confirmedBy ? `${author(campaign.confirmedBy)}, ${fmtAt(campaign.confirmedAt, cTz)}` : '–'}</dd>
            {campaign.plannedAt && <><dt>Плановая отправка</dt><dd>{fmtAt(campaign.plannedAt, cTz)}</dd></>}
            {campaign.erid && <><dt>erid</dt><dd>{campaign.erid}</dd></>}
            {campaign.cancelledReason && <><dt>Причина отмены</dt><dd>{campaign.cancelledReason}</dd></>}
            {detail && <><dt>Отправлено / только центр / исключено / ошибка</dt><dd data-testid="cc-counters">{`${detail.counters.sent} / ${detail.counters.inboxOnly} / ${detail.counters.excluded} / ${detail.counters.error}`}</dd></>}
          </dl>
          {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
          <div class="yc-eq__actions">
            <a class="yc-btn yc-btn--ghost" href="/notifications?tab=rows">Строки отправки в журнале</a>
            {canCancel && <button class="yc-btn yc-btn--ghost yc-btn--danger-text" type="button" onClick={() => { cancelKey.current = crypto.randomUUID(); setCancelReason(''); cancelDlg.current?.showModal(); }}>Отменить рассылку</button>}
          </div>
        </section>
        {detail && detail.timeline.length > 0 && (
          <section class="yc-panel" aria-labelledby="cc-history">
            <h2 id="cc-history">История</h2>
            <ul class="yc-history">
              {detail.timeline.map((t) => <li class="yc-history__item"><span class="yc-history__head">{fmtAt(t.at, cTz)} – {ACTION_LABEL[t.action] ?? t.action}, {author(t.actorId)}{t.reason ? `: ${t.reason}` : ''}</span></li>)}
            </ul>
          </section>
        )}
        <dialog ref={cancelDlg} class="yc-dialog" aria-labelledby="cc-cancel-title">
          <form class="yc-dialog__body" onSubmit={cancel}>
            <h2 id="cc-cancel-title">Отменить рассылку?</h2>
            <p>Оставшиеся сообщения не уйдут. Уже отправленные не отзываются.</p>
            <label class="yc-field"><span class="yc-field__label">Причина</span><input class="yc-input" value={cancelReason} maxlength={500} onInput={(e) => setCancelReason((e.target as HTMLInputElement).value)} /></label>
            <div class="yc-dialog__actions">
              <button class="yc-btn yc-btn--ghost" type="button" onClick={() => cancelDlg.current?.close()}>Не отменять</button>
              <button class="yc-btn yc-btn--danger" type="submit" disabled={busy}>Отменить рассылку</button>
            </div>
          </form>
        </dialog>
      </div>
    );
  }

  // ---- форма черновика
  const categories = ([['service', can.service], ['marketing', can.marketing]] as const).filter(([, ok]) => ok).map(([c]) => c);
  const usable = templates.filter((t) => t.status === 'active' && categories.includes(t.category));
  return (
    <div class="yc-list" data-testid="campaign-form">
      <section class="yc-panel" aria-labelledby="cf-title">
        <h2 id="cf-title">Текст и аудитория</h2>
        <form class="yc-form yc-form--wide" onSubmit={(e) => { e.preventDefault(); void check(); }} noValidate>
          {usable.length > 0 && (
            <label class="yc-field"><span class="yc-field__label">Шаблон</span>
              <select class="yc-input" value={d.templateId} onChange={(e) => applyTemplate((e.target as HTMLSelectElement).value)}>
                <option value="">Без шаблона</option>{usable.map((t) => <option value={t.id}>{t.name}</option>)}
              </select>
              <span class="yc-field__hint">Текст шаблона копируется в сообщение: правка шаблона потом его не изменит.</span>
            </label>
          )}
          <label class="yc-field"><span class="yc-field__label">Категория</span>
            <select class="yc-input" name="category" value={d.category} {...inv('category')} onChange={(e) => set('category', (e.target as HTMLSelectElement).value as Draft['category'])}>
              <option value="">Выберите категорию</option>{categories.map((c) => <option value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
            <span class="yc-field__hint">Сервисное – по записи клиента и уходит даже при отказе от рекламы. Реклама – только согласившимся.</span>
            {err('category')}
          </label>
          {d.category && (
            <>
              <fieldset class="yc-field" style="border:0;padding:0;margin:0">
                <legend class="yc-field__label">Кому</legend>
                <div class="yc-seg" role="group">
                  {kinds.map(([k, label]) => <button type="button" class="yc-seg__btn" aria-pressed={kind === k} onClick={() => set('kind', k)}>{label}</button>)}
                </div>
              </fieldset>
              {kind === 'client' && (
                <div class="yc-field">
                  <span class="yc-field__label">Клиент</span>
                  {d.clientId ? (
                    <p data-testid="cf-client">Выбран клиент <a href={`/clients/${d.clientId}`}>карточка</a> <button class="yc-link" type="button" onClick={() => set('clientId', '')}>Выбрать другого</button></p>
                  ) : (
                    <div class="yc-eq__actions">
                      <input class="yc-input" type="search" aria-label="Телефон или ФИО клиента" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} {...inv('clientId')} />
                      <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void search()}>Найти клиента</button>
                    </div>
                  )}
                  {!d.clientId && found.map((c) => <button class="yc-btn yc-btn--ghost" type="button" onClick={() => { set('clientId', c.id); setFound([]); }}>{[c.lastName, c.firstName].filter(Boolean).join(' ') || 'Без имени'} {c.phoneMasked}</button>)}
                  {err('clientId')}
                </div>
              )}
              {(kind === 'booking' || (kind === 'client' && d.category === 'service')) && (
                <label class="yc-field"><span class="yc-field__label">Запись клиента (ID)</span>
                  <input class="yc-input" name="bookingId" value={d.bookingId} maxlength={36} {...inv('bookingId')} onInput={(e) => set('bookingId', (e.target as HTMLInputElement).value)} />
                  <span class="yc-field__hint">ID из карточки записи. Сообщение получит клиент этой записи.</span>
                  {err('bookingId')}
                </label>
              )}
              {kind === 'client' && d.category === 'marketing' && branches.length > 0 && (
                <label class="yc-field"><span class="yc-field__label">Филиал</span>
                  <select class="yc-input" name="branchId" value={d.branchId} {...inv('branchId')} onChange={(e) => set('branchId', (e.target as HTMLSelectElement).value)}>
                    <option value="">{can.network ? 'Вся сеть' : 'Выберите филиал'}</option>{branches.map((b) => <option value={b.id}>{b.name}</option>)}
                  </select>
                  {err('branchId')}
                </label>
              )}
              {kind === 'segment' && (
                <fieldset class="yc-eq__filters" style="border:0;padding:0;margin:0" data-testid="cf-segment">
                  <label class="yc-field"><span class="yc-field__label">Область</span>
                    <select class="yc-input" name="area" value={d.area} {...inv('area')} onChange={(e) => set('area', (e.target as HTMLSelectElement).value)}>
                      <option value="">Выберите</option>
                      {can.network && <option value="network">Вся сеть</option>}
                      {cities.map(([id, name]) => <option value={`city:${id}`}>Город: {name}</option>)}
                      {branches.map((b) => <option value={`branch:${b.id}`}>Филиал: {b.name}</option>)}
                    </select>
                    {err('area')}
                  </label>
                  <label class="yc-field"><span class="yc-field__label">Были с</span><input class="yc-input" type="date" value={d.visitedFrom} onInput={(e) => set('visitedFrom', (e.target as HTMLInputElement).value)} /></label>
                  <label class="yc-field"><span class="yc-field__label">Были по</span><input class="yc-input" type="date" value={d.visitedTo} onInput={(e) => set('visitedTo', (e.target as HTMLInputElement).value)} /></label>
                  <label class="yc-field"><span class="yc-field__label">Не были с</span><input class="yc-input" type="date" value={d.notVisitedSince} onInput={(e) => set('notVisitedSince', (e.target as HTMLInputElement).value)} /></label>
                  <label class="yc-field"><span class="yc-field__label">Посещений не меньше</span><input class="yc-input" type="number" min={1} max={1000} value={d.minVisits} onInput={(e) => set('minVisits', (e.target as HTMLInputElement).value)} /></label>
                  <label class="yc-field"><span class="yc-field__label">Будущая запись</span>
                    <select class="yc-input" value={d.upcoming} onChange={(e) => set('upcoming', (e.target as HTMLSelectElement).value as Draft['upcoming'])}><option value="">Не важно</option><option value="yes">Есть</option><option value="no">Нет</option></select>
                  </label>
                  <div class="yc-field"><span class="yc-field__label">Направления</span>
                    {(['pc', 'vr', 'ps'] as const).map((t) => (
                      <label class="yc-check"><input type="checkbox" checked={d.directions.includes(t)} onChange={(e) => set('directions', (e.target as HTMLInputElement).checked ? [...d.directions, t] : d.directions.filter((x) => x !== t))} />{DIRECTION_LABEL[t]}</label>
                    ))}
                  </div>
                </fieldset>
              )}
              {kind !== 'segment' && (
                <label class="yc-field"><span class="yc-field__label">Назначение</span>
                  <input class="yc-input" name="purpose" value={d.purpose} maxlength={200} {...inv('purpose')} onInput={(e) => set('purpose', (e.target as HTMLInputElement).value)} />
                  <span class="yc-field__hint">Зачем пишем клиенту лично, например «перенос комнаты». Клиент этого поля не видит.</span>
                  {err('purpose')}
                </label>
              )}
              <label class="yc-field"><span class="yc-field__label">Заголовок</span>
                <input class="yc-input" name="title" value={d.title} maxlength={120} {...inv('title')} onInput={(e) => set('title', (e.target as HTMLInputElement).value)} />
                {err('title')}
              </label>
              <label class="yc-field"><span class="yc-field__label">Текст</span>
                <textarea class="yc-input" name="body" rows={4} value={d.body} maxlength={500} {...inv('body')} onInput={(e) => set('body', (e.target as HTMLTextAreaElement).value)} />
                <span class="yc-field__hint">Подстановки: {PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.</span>
                {err('body')}
              </label>
              <label class="yc-field"><span class="yc-field__label">Ссылка в сообщении (необязательно)</span>
                <input class="yc-input" name="url" value={d.url} maxlength={500} placeholder="/account/bookings" {...inv('url')} onInput={(e) => set('url', (e.target as HTMLInputElement).value)} />
                {err('url')}
              </label>
              <label class="yc-field"><span class="yc-field__label">Отправить позже (необязательно)</span>
                <input class="yc-input" type="datetime-local" name="plannedAt" value={d.plannedAt} {...inv('plannedAt')} onInput={(e) => set('plannedAt', (e.target as HTMLInputElement).value)} />
                <span class="yc-field__hint">Время филиала. Пусто – сразу после подтверждения; реклама уйдёт в разрешённые часы.</span>
                {err('plannedAt')}
              </label>
              <label class="yc-check"><input type="checkbox" checked={d.push} onChange={(e) => set('push', (e.target as HTMLInputElement).checked)} />Отправить push (без него – только в центр уведомлений)</label>
              {d.category === 'marketing' && (
                <>
                  <label class="yc-field"><span class="yc-field__label">erid (маркировка рекламы)</span>
                    <input class="yc-input" name="erid" value={d.erid} maxlength={64} {...inv('erid')} onInput={(e) => set('erid', (e.target as HTMLInputElement).value)} />
                    {err('erid')}
                  </label>
                  <label class="yc-field"><span class="yc-field__label">Рекламодатель (необязательно)</span>
                    <input class="yc-input" name="advertiserNote" value={d.advertiserNote} maxlength={200} onInput={(e) => set('advertiserNote', (e.target as HTMLInputElement).value)} />
                  </label>
                </>
              )}
              {error && <p class="yc-alert yc-alert--error" role="alert" data-testid="cf-error">{error}</p>}
              <div class="yc-eq__actions">
                <button class="yc-btn" type="submit" disabled={busy}>Проверить аудиторию</button>
                <button class="yc-btn yc-btn--ghost" type="button" disabled={busy} onClick={() => void saveOnly()}>Сохранить черновик</button>
              </div>
            </>
          )}
        </form>
      </section>
      {preview && campaign && !dirty && d.category && (
        <AudiencePreview preview={preview} category={d.category} title={campaign.title} body={campaign.body} audience={describe(campaign.audience)}
          send={send} refresh={() => loadPreview(campaign.id)} disabled={busy} />
      )}
    </div>
  );
}
