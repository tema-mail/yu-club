// Журнал отправок (S4-80; 09 §12.1–§12.2, K21 §9, K11 №201, №208, №209). Две вкладки: «Рассылки» (кампании со счётчиками
// «отправлено / только центр / исключено / ошибка») и «Отправки» (строки уведомлений). Фильтры 09 §12.2 – обычной формой GET:
// период, филиал, категория, источник, автор, статус, клиент; адрес хранит условия, «Сбросить» – ссылка без них.
// Время – в зоне филиала строки (K8), у сетевой – в зоне контекста. Пустая выдача показывает условия и сброс (13 §7.4),
// ошибка загрузки – отдельно, с повтором. Повтор критичного сервисного – только при notifications.retry, с причиной, один ключ на попытку.
import { useEffect, useRef, useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import {
  CAMPAIGN_BADGE, CAMPAIGN_STATUS, CATEGORY_LABEL, KIND_LABEL, ROW_BADGE, ROW_STATUS, SOURCE_LABEL, canRetryRow, describeAudience, fmtAt, nextDay, notificationError, zonedDayStart,
  type CampaignListRow, type CampaignStatus, type NotificationView, type Page, type RowStatus,
} from '../lib/notifications.ts';

export interface JournalFilters {
  from: string; to: string; branchId: string; category: string; source: string; authorId: string; status: string; clientId: string; kind: string;
}
export interface NotificationJournalProps {
  tab: 'campaigns' | 'rows';
  filters: JournalFilters;
  branches: Array<{ id: string; name: string; cityId: string; cityName: string; timezone: string }>;
  /** Зона контекста: для строк без филиала и для периода без выбранного филиала. */
  timezone: string;
  staffNames: Record<string, string>;
  meId: string;
  canRetry: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 20;

export default function NotificationJournal({ tab, filters: f, branches, timezone, staffNames, meId, canRetry }: NotificationJournalProps) {
  const [items, setItems] = useState<Array<CampaignListRow | NotificationView>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [target, setTarget] = useState<NotificationView | null>(null);
  const [reason, setReason] = useState('');
  const [dlgError, setDlgError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const dlg = useRef<HTMLDialogElement>(null);
  const attempt = useRef('');

  const branchName = (id: string | null) => (id ? (branches.find((b) => b.id === id)?.name ?? 'Филиал') : 'Вся сеть');
  const cityName = (id: string) => branches.find((b) => b.cityId === id)?.cityName ?? 'Город';
  const tzOf = (branchId: string | null) => branches.find((b) => b.id === branchId)?.timezone ?? timezone;
  const author = (id: string | null) => (!id ? 'Система' : id === meId ? 'Вы' : (staffNames[id] ?? 'Сотрудник'));
  const periodTz = tzOf(f.branchId || null);
  const clientBad = f.clientId !== '' && !UUID.test(f.clientId);

  const query = (after: string | null) => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (f.from) p.set('from', zonedDayStart(f.from, periodTz));
    if (f.to) p.set('to', zonedDayStart(nextDay(f.to), periodTz));
    for (const k of ['branchId', 'category', 'source', 'status', 'clientId'] as const) if (f[k]) p.set(k, f[k]);
    if (tab === 'campaigns' && f.authorId) p.set('authorId', f.authorId);
    if (tab === 'rows' && f.kind) p.set('kind', f.kind);
    if (after) p.set('cursor', after);
    return p;
  };
  const load = async (after: string | null) => {
    if (clientBad) {
      setState('error');
      setError('ID клиента – 36 символов вида 1b4e28ba-2fa1-11d2-883f-0016d3cca427. Скопируйте его из карточки клиента.');
      return;
    }
    if (!after) setState('loading');
    try {
      const r = await browserCall<Page<CampaignListRow | NotificationView>>(`${tab === 'campaigns' ? '/notifications/campaigns' : '/notifications'}?${query(after)}`);
      setItems((prev) => (after ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
      setState('ready');
    } catch (e) {
      setError(notificationError(e));
      setState('error');
    }
  };
  useEffect(() => {
    void load(null);
  }, []);

  const openRetry = (n: NotificationView) => {
    setTarget(n);
    setReason('');
    setDlgError('');
    attempt.current = crypto.randomUUID();
    dlg.current?.showModal();
  };
  const retry = async (e: Event) => {
    e.preventDefault();
    if (busy || !target) return;
    if (!reason.trim()) return setDlgError('Укажите, почему повторяете отправку.');
    setBusy(true);
    try {
      await browserCall(`/notifications/${encodeURIComponent(target.id)}/retry`, { method: 'POST', body: { reason: reason.trim() }, key: attempt.current });
      dlg.current?.close();
      setNotice('Повтор поставлен в очередь: новая строка в журнале, исходная осталась как была.');
      await load(null);
    } catch (err) {
      setDlgError(notificationError(err));
    } finally {
      setBusy(false);
    }
  };

  // Применённые условия – словами (13 §7.4)
  const applied: string[] = [];
  if (f.from || f.to) applied.push(`период ${f.from ? `с ${f.from.split('-').reverse().join('.')}` : ''} ${f.to ? `по ${f.to.split('-').reverse().join('.')}` : ''}`.trim());
  if (f.branchId) applied.push(`филиал «${branchName(f.branchId)}»`);
  if (f.category) applied.push(`категория «${CATEGORY_LABEL[f.category as keyof typeof CATEGORY_LABEL] ?? f.category}»`);
  if (f.source) applied.push(`источник «${SOURCE_LABEL[f.source as 'system' | 'staff'] ?? f.source}»`);
  if (tab === 'campaigns' && f.authorId) applied.push(`автор «${author(f.authorId)}»`);
  if (f.status) applied.push(`статус «${(tab === 'campaigns' ? CAMPAIGN_STATUS[f.status as CampaignStatus] : ROW_STATUS[f.status as RowStatus]) ?? f.status}»`);
  if (tab === 'rows' && f.kind) applied.push(`вид «${KIND_LABEL[f.kind] ?? f.kind}»`);
  if (f.clientId) applied.push('один клиент');
  const reset = `/notifications${tab === 'rows' ? '?tab=rows' : ''}`;
  const statuses = tab === 'campaigns' ? Object.entries(CAMPAIGN_STATUS) : Object.entries(ROW_STATUS).filter(([k]) => k !== 'delivered');
  const categories = tab === 'campaigns' ? (['service', 'marketing'] as const) : (['service', 'reminder', 'marketing'] as const);

  return (
    <div class="yc-list" data-testid={`journal-${tab}`}>
      <section class="yc-panel" aria-labelledby="nt-filter">
        <h2 id="nt-filter">Фильтры</h2>
        <form class="yc-eq__filters" method="get" action="/notifications">
          {tab === 'rows' && <input type="hidden" name="tab" value="rows" />}
          <label class="yc-field"><span class="yc-field__label">Период с</span><input class="yc-input" type="date" name="from" value={f.from} /></label>
          <label class="yc-field"><span class="yc-field__label">по</span><input class="yc-input" type="date" name="to" value={f.to} /></label>
          {branches.length > 1 && (
            <label class="yc-field"><span class="yc-field__label">Филиал</span>
              <select class="yc-input" name="branchId"><option value="">Все филиалы зоны</option>{branches.map((b) => <option value={b.id} selected={f.branchId === b.id}>{b.name}</option>)}</select>
            </label>
          )}
          <label class="yc-field"><span class="yc-field__label">Категория</span>
            <select class="yc-input" name="category"><option value="">Любая</option>{categories.map((c) => <option value={c} selected={f.category === c}>{CATEGORY_LABEL[c]}</option>)}</select>
          </label>
          <label class="yc-field"><span class="yc-field__label">Источник</span>
            <select class="yc-input" name="source"><option value="">Любой</option>{(['system', 'staff'] as const).map((s) => <option value={s} selected={f.source === s}>{SOURCE_LABEL[s]}</option>)}</select>
          </label>
          {tab === 'campaigns' && (
            <label class="yc-field"><span class="yc-field__label">Автор</span>
              <select class="yc-input" name="authorId">
                <option value="">Любой</option>
                <option value={meId} selected={f.authorId === meId}>Вы</option>
                {Object.entries(staffNames).filter(([id]) => id !== meId).map(([id, name]) => <option value={id} selected={f.authorId === id}>{name}</option>)}
              </select>
            </label>
          )}
          <label class="yc-field"><span class="yc-field__label">Статус</span>
            <select class="yc-input" name="status"><option value="">Любой</option>{statuses.map(([k, v]) => <option value={k} selected={f.status === k}>{v}</option>)}</select>
          </label>
          {tab === 'rows' && (
            <label class="yc-field"><span class="yc-field__label">Вид</span>
              <select class="yc-input" name="kind"><option value="">Любой</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option value={k} selected={f.kind === k}>{v}</option>)}</select>
            </label>
          )}
          <label class="yc-field"><span class="yc-field__label">ID клиента</span><input class="yc-input" type="search" name="clientId" value={f.clientId} maxlength={36} /></label>
          <button class="yc-btn yc-btn--ghost" type="submit">Найти</button>
          {applied.length > 0 && <a class="yc-btn yc-btn--ghost" href={reset}>Сбросить</a>}
        </form>
      </section>
      {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}
      <section class="yc-panel" aria-label={tab === 'campaigns' ? 'Рассылки' : 'Отправки'} aria-busy={state === 'loading'}>
        {state === 'loading' && <p class="yc-empty" role="status">Загружаем…</p>}
        {state === 'error' && (
          <div class="yc-list__error" role="alert" data-testid="journal-error">
            <p class="yc-alert yc-alert--error">{error}</p>
            {!clientBad && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => void load(null)}>Повторить</button>}
          </div>
        )}
        {state === 'ready' && items.length === 0 && (
          <div class="yc-list__empty" data-testid="journal-empty">
            <p>{applied.length ? `Ничего не найдено. Условия: ${applied.join(', ')}.` : tab === 'campaigns' ? 'Рассылок пока нет.' : 'Отправок пока нет.'}</p>
            {applied.length > 0 && <a class="yc-btn yc-btn--ghost" href={reset}>Сбросить фильтры</a>}
          </div>
        )}
        {state === 'ready' && items.length > 0 && tab === 'campaigns' && (
          <div class="yc-pay-scroll"><table class="yc-table" data-testid="campaigns">
            <thead><tr><th>Заголовок</th><th>Создана / отправка</th><th>Категория</th><th>Источник, автор</th><th>Аудитория</th><th>Адресатов</th><th><abbr title="Отправлено провайдеру / только в центре уведомлений / исключено / ошибка">Отпр. / центр / искл. / ошибка</abbr></th><th>Статус</th></tr></thead>
            <tbody>
              {(items as CampaignListRow[]).map((c) => {
                const tz = c.areaType === 'branch' ? tzOf(c.areaIds[0] ?? null) : timezone;
                return (
                  <tr data-testid={`campaign-${c.id}`}>
                    <td class="yc-table__main"><a href={`/notifications/campaigns/${c.id}`}>{c.title}</a></td>
                    <td data-label="Создана / отправка">{fmtAt(c.createdAt, tz)}<br />{c.plannedAt ? `план ${fmtAt(c.plannedAt, tz)}` : fmtAt(c.confirmedAt, tz)}</td>
                    <td data-label="Категория">{CATEGORY_LABEL[c.category]}</td>
                    <td data-label="Источник, автор">{SOURCE_LABEL.staff}: {author(c.createdBy)}</td>
                    <td data-label="Аудитория">{describeAudience(c.audience, { branch: branchName, city: cityName })}</td>
                    <td data-label="Адресатов">{c.total ?? '–'}</td>
                    <td data-label="Отправлено / центр / исключено / ошибка" data-testid="counters">{`${c.counters.sent} / ${c.counters.inboxOnly} / ${c.counters.excluded} / ${c.counters.error}`}</td>
                    <td data-label="Статус"><span class={`yc-badge yc-badge--${CAMPAIGN_BADGE[c.status]}`}>{CAMPAIGN_STATUS[c.status]}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
        {state === 'ready' && items.length > 0 && tab === 'rows' && (
          <div class="yc-pay-scroll"><table class="yc-table" data-testid="rows">
            <thead><tr><th>Заголовок</th><th>Создано / отправлено</th><th>Категория, вид</th><th>Источник, автор</th><th>Получатель, филиал</th><th>Статус</th><th>Действие</th></tr></thead>
            <tbody>
              {(items as NotificationView[]).map((n) => {
                const tz = tzOf(n.branchId);
                return (
                  <tr data-testid={`row-${n.id}`}>
                    <td class="yc-table__main">{n.title}</td>
                    <td data-label="Создано / отправлено">{fmtAt(n.plannedAt, tz)}<br />{fmtAt(n.sentAt, tz)}</td>
                    <td data-label="Категория, вид">{CATEGORY_LABEL[n.category]}<br />{KIND_LABEL[n.kind] ?? n.kind}{n.retryOf ? ' (повтор)' : ''}</td>
                    <td data-label="Источник, автор">{n.source === 'system' ? SOURCE_LABEL.system : `${SOURCE_LABEL.staff}: ${author(n.initiatorId)}`}</td>
                    <td data-label="Получатель, филиал"><a href={`/clients/${n.clientId}`}>Карточка клиента</a><br />{branchName(n.branchId)}</td>
                    <td data-label="Статус">
                      <span class={`yc-badge yc-badge--${ROW_BADGE[n.status] ?? 'archived'}`}>{ROW_STATUS[n.status] ?? n.status}</span>
                      {(n.error || n.skipReason) && <span class="yc-field__hint"> {n.error ?? (n.skipReason === 'no_subscription' ? 'нет подписки на push' : n.skipReason)}</span>}
                    </td>
                    <td>{canRetry && canRetryRow(n) && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => openRetry(n)}>Повторить</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
        {state === 'ready' && cursor && <div class="yc-list__more"><button class="yc-btn yc-btn--ghost" type="button" onClick={() => void load(cursor)}>Показать ещё</button></div>}
      </section>
      <dialog ref={dlg} class="yc-dialog" aria-labelledby="nt-retry-title">
        <form class="yc-dialog__body" onSubmit={retry}>
          <h2 id="nt-retry-title">Повторить отправку?</h2>
          <p>{target?.title}</p>
          <p class="yc-field__hint">Уйдёт новое сообщение, исходная строка останется в журнале. Повтор рекламы не делается.</p>
          <label class="yc-field"><span class="yc-field__label">Причина</span>
            <input class="yc-input" value={reason} maxlength={500} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
          </label>
          {dlgError && <p class="yc-alert yc-alert--error" role="alert">{dlgError}</p>}
          <div class="yc-dialog__actions">
            <button class="yc-btn yc-btn--ghost" type="button" onClick={() => dlg.current?.close()}>Не повторять</button>
            <button class="yc-btn" type="submit" disabled={busy}>Повторить отправку</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
