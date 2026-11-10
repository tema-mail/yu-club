// Глобальный поиск в шапке CRM (S4-95; 13 §7.1, K24 §5, K11 №250): клиенты, брони, операции кассы, сотрудники, мероприятия,
// оборудование – в пределах прав (тип без права сервер не присылает). Группы по типам, до 5 в группе, «Показать все» – в список типа.
// «Ничего не найдено» – спокойная подсказка, а не ошибка. Клавиатура: «/» – фокус в поле (кроме ввода в другом поле), стрелки –
// по найденному, Enter – открыть, Escape – закрыть. Запрос – после паузы в наборе, прежний отменяется.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../lib/api.ts';
import { BOOKING_STATUS_LABEL, fmtValue, reportError, type SearchGroup, type SearchType } from '../lib/reports.ts';
import { getJson } from './ReportView.tsx';

const TITLES: Record<SearchType, string> = { client: 'Клиенты', booking: 'Брони', finance_operation: 'Операции кассы', staff: 'Сотрудники', event: 'Мероприятия', equipment: 'Оборудование' };
const ROLE: Record<string, string> = { owner: 'Владелец', director: 'Директор', admin: 'Администратор' };
const DEBOUNCE_MS = 300;

interface Hit { id: string; href: string; title: string; sub: string }

function hitOf(type: SearchType, x: Record<string, unknown>): Hit {
  const id = String(x.id);
  const enc = encodeURIComponent(id);
  switch (type) {
    case 'client':
      return { id, href: `/clients/${enc}`, title: String(x.name ?? 'Без имени'), sub: `${String(x.phone ?? '')}${x.kind === 'guest' ? ' · гость' : ''}` };
    case 'booking':
      return { id, href: `/bookings/${enc}`, title: `Бронь № ${String(x.number)}`, sub: `${String(x.startLocal ?? '')} · ${String(x.resourceName ?? '')} · ${BOOKING_STATUS_LABEL[String(x.status)] ?? String(x.status)}` };
    case 'finance_operation':
      return { id, href: `/finance/operations/${enc}`, title: `Операция № ${String(x.number)}`, sub: `${fmtValue(Number(x.amountKop), 'kop')}${x.comment ? ` · ${String(x.comment)}` : ''}` };
    case 'staff':
      return { id, href: `/staff/${enc}`, title: String(x.name), sub: ROLE[String(x.role)] ?? '' };
    case 'event':
      return { id, href: `/events/${enc}`, title: `Мероприятие ${String(x.number)}`, sub: x.heldOn ? String(x.heldOn).split('-').reverse().join('.') : '' };
    case 'equipment':
      return { id, href: `/equipment/${enc}`, title: String(x.inventoryNo), sub: x.serialNo ? `серийный ${String(x.serialNo)}` : '' };
  }
}
const allHref = (type: SearchType, q: string): string => {
  const e = encodeURIComponent(q);
  return { client: `/clients?q=${e}`, staff: `/staff?q=${e}`, booking: '/schedule', finance_operation: '/finance', event: '/events', equipment: '/equipment' }[type];
};

export default function GlobalSearch() {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<SearchGroup[] | null>(null);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const ctrl = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const run = async (text: string) => {
    ctrl.current?.abort();
    const t = text.trim();
    setError('');
    setActive(-1);
    if (t.length < 2) {
      setGroups(null);
      setHint(t ? 'Введите не меньше 2 символов' : '');
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    try {
      const r = await getJson<{ groups: SearchGroup[] }>(`/search?${new URLSearchParams({ q: t })}`, c.signal);
      setGroups(r.groups);
      setHint('');
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setGroups(null);
      if (e instanceof ApiError && e.code === 'SEARCH_QUERY_TOO_SHORT') setHint(reportError(e));
      else setError(reportError(e));
    }
  };
  const onInput = (v: string) => {
    setQ(v);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(v), DEBOUNCE_MS);
  };

  const visible = (groups ?? []).filter((g) => g.items.length > 0);
  const hits = visible.flatMap((g) => g.items.map((x) => ({ type: g.type, ...hitOf(g.type, x) })));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => (i + 1) % hits.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i <= 0 ? hits.length - 1 : i - 1)); }
    if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.assign(hits[active]!.href); }
  };
  let n = -1;

  return (
    <div class="yc-gsearch" role="search" style="position:relative;min-width:0;flex:1 1 14rem;max-width:28rem"
      onFocusOut={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <label class="yc-field" style="gap:0">
        <span class="yc-field__label" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Поиск по CRM</span>
        <input ref={input} class="yc-input" type="text" enterKeyHint="search" name="globalSearch" value={q} maxLength={100} autoComplete="off" placeholder="Поиск: клиент, телефон, № брони…  ( / )"
          role="combobox" aria-expanded={open && (groups !== null || hint !== '' || error !== '')} aria-controls="gsearch-list" aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `gs-${active}` : undefined}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)} onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
      </label>
      {open && (groups !== null || hint || error) && (
        <div id="gsearch-list" data-testid="search-results" style="position:absolute;z-index:20;left:0;right:0;top:calc(100% + 4px);max-height:70vh;overflow:auto;background:var(--yc-surface);border:1px solid var(--yc-line);border-radius:var(--yc-r-m);box-shadow:0 8px 24px rgb(0 0 0 / .12);padding:var(--yc-sp-2xs)">
          {hint && <p class="yc-field__hint" data-testid="search-hint" style="margin:var(--yc-sp-2xs)">{hint}</p>}
          {error && <p class="yc-alert yc-alert--error" role="alert" style="margin:0">{error}</p>}
          {groups !== null && visible.length === 0 && (
            <p data-testid="search-empty" style="margin:var(--yc-sp-2xs);color:var(--yc-muted)">По запросу «{q.trim()}» ничего не нашлось. Проверьте написание или поищите по телефону, номеру брони или дате.</p>
          )}
          {visible.map((g) => (
            <div key={g.type} role="group" aria-label={TITLES[g.type]} data-testid={`search-group-${g.type}`}>
              <p style="margin:var(--yc-sp-2xs) var(--yc-sp-2xs) var(--yc-sp-3xs);font-size:var(--yc-fs-xs);font-weight:600;color:var(--yc-muted)">{TITLES[g.type]}</p>
              <ul role="listbox" style="list-style:none;margin:0;padding:0">
                {g.items.map((x) => {
                  const h = hitOf(g.type, x);
                  const i = ++n;
                  return (
                    <li key={h.id} id={`gs-${i}`} role="option" aria-selected={active === i}>
                      <a href={h.href} style={`display:grid;padding:var(--yc-sp-2xs);border-radius:var(--yc-r-s);color:inherit;text-decoration:none;${active === i ? 'background:var(--yc-accent-bg)' : ''}`}
                        onMouseMove={() => setActive(i)} tabIndex={-1}>
                        <span>{h.title}</span><span style="font-size:var(--yc-fs-xs);color:var(--yc-muted)">{h.sub}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
              {g.more && <a href={allHref(g.type, q.trim())} style="display:block;padding:var(--yc-sp-3xs) var(--yc-sp-2xs);font-size:var(--yc-fs-xs)">Показать все: {TITLES[g.type].toLowerCase()}</a>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
