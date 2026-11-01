// Общий список CRM (S0-15): поиск, фильтры, «Действующие / Архив», порции по nextCursor (K11), пустое и ошибочное
// состояния. Удаления в списке нет – только внутри записи (EntityCard). Все настройки – данными в props (остров Astro).
// Поиск и архив бывают двух видов: на сервере (параметр запроса) и на месте (по загруженному списку – справочники
// отдают всё одним ответом, без курсора).
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

export interface ListColumn {
  key: string;
  label: string;
  /** Главная колонка: ссылка на запись. */
  main?: boolean;
  /** Значение → подпись в плашке (статусы). */
  badge?: Record<string, string>;
  /** Да / Нет. */
  yesNo?: boolean;
  /** Значение → подпись (без плашки). */
  labels?: Record<string, string>;
}

export interface ListFilter {
  param: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

export interface ListProps {
  /** Путь API без префикса /api/crm/v1, например '/branches'. */
  endpoint: string;
  columns: ListColumn[];
  /** Адрес записи, поля подставляются: '/network/branches/{id}'. */
  rowHref: string;
  /** Постоянные параметры запроса. */
  query?: Record<string, string>;
  /** param – поиск на сервере; fields – поиск на месте по этим полям. */
  search?: { label: string; param?: string; fields?: string[] };
  filters?: ListFilter[];
  /** param – архив на сервере (param=true); field – на месте: запись в архиве, если поле не пустое. */
  archive?: { param?: string; field?: string };
  /** Метка «системное» – по этому полю. */
  systemField?: string;
  pageSize?: number;
  /** Нет ни одной записи (без поиска и фильтров). */
  emptyText: string;
  testId: string;
}

type Row = Record<string, unknown>;
interface PageResult {
  items: Row[];
  nextCursor?: string | null;
}

export function fill(template: string, row: Row): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(row[k] ?? '')));
}

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Неизвестная ошибка';
}

/** Начальные условия – из адреса страницы: ссылку на отфильтрованный список можно переслать. */
function initial(props: ListProps) {
  const sp = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  const filters: Record<string, string> = {};
  for (const f of props.filters ?? []) filters[f.param] = sp.get(f.param) ?? '';
  return { q: sp.get('q') ?? '', filters, archived: sp.get('archived') === 'true' };
}

export default function EntityList(props: ListProps) {
  const { columns, search, filters = [], archive, systemField, pageSize = 50 } = props;
  const init = useRef(initial(props)).current;
  const [q, setQ] = useState(init.q);
  const [appliedQ, setAppliedQ] = useState(init.q);
  const [filterValues, setFilterValues] = useState(init.filters);
  const [archived, setArchived] = useState(init.archived);
  const [items, setItems] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [moreError, setMoreError] = useState('');
  const requestNo = useRef(0); // ответ на устаревшие условия выбрасываем

  const params = (next: string | null): string => {
    const sp = new URLSearchParams(props.query ?? {});
    if (search?.param && appliedQ.trim()) sp.set(search.param, appliedQ.trim());
    for (const [k, v] of Object.entries(filterValues)) if (v) sp.set(k, v);
    if (archive?.param && archived) sp.set(archive.param, 'true');
    sp.set('limit', String(pageSize));
    if (next) sp.set('cursor', next);
    return sp.toString();
  };

  const load = async (more: boolean) => {
    const no = ++requestNo.current;
    if (more) setMoreState('loading');
    else setState('loading');
    try {
      const r = await browserCall<PageResult>(`${props.endpoint}?${params(more ? cursor : null)}`);
      if (no !== requestNo.current) return;
      setItems((prev) => (more ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor ?? null);
      setState('ready');
      setMoreState('idle');
    } catch (e) {
      if (no !== requestNo.current) return;
      if (more) {
        setMoreState('error');
        setMoreError(errorText(e));
      } else {
        setState('error');
        setError(errorText(e));
      }
    }
  };

  useEffect(() => {
    void load(false);
    const sp = new URLSearchParams();
    if (appliedQ.trim()) sp.set('q', appliedQ.trim());
    for (const [k, v] of Object.entries(filterValues)) if (v) sp.set(k, v);
    if (archived) sp.set('archived', 'true');
    const qs = sp.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
  }, [appliedQ, filterValues, archived]);

  // Поиск – по паузе в наборе, без кнопки.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const needle = appliedQ.trim().toLowerCase();
  const shown = items.filter((r) => {
    if (archive?.field && Boolean(r[archive.field]) !== archived) return false;
    if (search?.fields && needle) return search.fields.some((f) => String(r[f] ?? '').toLowerCase().includes(needle));
    return true;
  });
  const narrowed = Boolean(needle) || Object.values(filterValues).some(Boolean);

  const reset = () => {
    setQ('');
    setAppliedQ('');
    setFilterValues(Object.fromEntries(filters.map((f) => [f.param, ''])));
  };

  const cell = (c: ListColumn, r: Row) => {
    const v = r[c.key];
    if (c.badge) return <span class={`yc-badge yc-badge--${String(v)}`}>{c.badge[String(v)] ?? String(v ?? '')}</span>;
    if (c.yesNo) return v ? 'Да' : 'Нет';
    if (c.labels) return c.labels[String(v)] ?? String(v ?? '');
    return v === null || v === undefined || v === '' ? '–' : String(v);
  };

  return (
    <div class="yc-list" data-testid={props.testId}>
      <div class="yc-list__bar">
        {archive && (
          <div class="yc-seg" role="group" aria-label="Какие записи">
            <button type="button" class="yc-seg__btn" aria-pressed={!archived} onClick={() => setArchived(false)}>
              Действующие
            </button>
            <button type="button" class="yc-seg__btn" aria-pressed={archived} onClick={() => setArchived(true)}>
              Архив
            </button>
          </div>
        )}
        {search && (
          <div class="yc-field yc-list__search">
            <label class="yc-field__label" for={`${props.testId}-q`}>
              {search.label}
            </label>
            <input id={`${props.testId}-q`} class="yc-input" type="search" value={q}
              onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
          </div>
        )}
        {filters.map((f) => (
          <div class="yc-field" key={f.param}>
            <label class="yc-field__label" for={`${props.testId}-${f.param}`}>
              {f.label}
            </label>
            <select
              id={`${props.testId}-${f.param}`}
              class="yc-input"
              value={filterValues[f.param]}
              onChange={(e) => setFilterValues({ ...filterValues, [f.param]: (e.currentTarget as HTMLSelectElement).value })}
            >
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {state === 'loading' && <p class="yc-empty" role="status">Загрузка…</p>}

      {state === 'error' && (
        <div class="yc-alert yc-alert--error yc-list__error" role="alert">
          <span>Список не загрузился: {error.replace(/\.$/, '')}.</span>
          <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void load(false)}>
            Повторить
          </button>
        </div>
      )}

      {state === 'ready' && shown.length === 0 && (
        <div class="yc-list__empty" data-testid="list-empty">
          {narrowed ? (
            <>
              <p class="yc-empty">Ничего не найдено по этим условиям.</p>
              <button type="button" class="yc-btn yc-btn--ghost" onClick={reset}>
                Сбросить поиск и фильтры
              </button>
            </>
          ) : (
            <p class="yc-empty">{archived ? 'В архиве пока ничего нет.' : props.emptyText}</p>
          )}
        </div>
      )}

      {state === 'ready' && shown.length > 0 && (
        <>
          <table class="yc-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th scope="col" key={c.key}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={String(r.id ?? r.code ?? i)}>
                  {columns.map((c) =>
                    c.main ? (
                      <td class="yc-table__main" key={c.key}>
                        <a href={fill(props.rowHref, r)}>{cell(c, r)}</a>
                        {systemField && r[systemField] ? <span class="yc-badge yc-badge--system">Системное</span> : null}
                      </td>
                    ) : (
                      <td data-label={c.label} key={c.key}>
                        {cell(c, r)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div class="yc-list__more">
            <p class="yc-empty" role="status">Показано: {shown.length}</p>
            {cursor && moreState !== 'error' && (
              <button type="button" class="yc-btn yc-btn--ghost" disabled={moreState === 'loading'} onClick={() => void load(true)}>
                {moreState === 'loading' ? 'Загрузка…' : 'Показать ещё'}
              </button>
            )}
            {moreState === 'error' && (
              <div class="yc-alert yc-alert--error yc-list__error" role="alert">
                <span>Следующая порция не загрузилась: {moreError.replace(/\.$/, '')}.</span>
                <button type="button" class="yc-btn yc-btn--ghost" onClick={() => void load(true)}>
                  Повторить
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
