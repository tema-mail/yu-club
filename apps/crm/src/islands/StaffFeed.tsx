// Лента событий CRM (S4-97; 13 §11, S4-28, D4-46): значок непрочитанных в шапке и панель событий – смены (только своя), ремонт,
// не дошедшее клиенту критичное сервисное – в пределах прав и зоны (чужое сервер не присылает). Без push сотрудникам (Q-147):
// значок обновляется при открытии страницы и раз в минуту. Событие ведёт в карточку и отмечается прочитанным; «Только
// непрочитанные», «Отметить все прочитанными», «Показать ещё» по курсору. Escape и щелчок мимо – закрыть.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

type Kind = 'shift_changed' | 'repair_registered' | 'repair_closed' | 'service_notification_failed';
export interface FeedItem {
  id: string; kind: Kind; branchId: string; branchName: string; refType: 'shift' | 'repair' | 'client'; refId: string;
  title: string; body: string | null; occurredAt: string; read: boolean;
}
interface FeedPage { items: FeedItem[]; nextCursor: string | null; unread: number }

const KIND: Record<Kind, string> = { shift_changed: 'Смена', repair_registered: 'Ремонт', repair_closed: 'Ремонт', service_notification_failed: 'Уведомление клиенту' };
const HREF = { shift: '/shifts/', repair: '/repairs/', client: '/clients/' } as const;
const POLL_MS = 60_000;
const when = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Не удалось загрузить события. Повторите.');

export default function StaffFeed() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const count = async () => {
    try {
      setUnread((await browserCall<{ unread: number }>('/staff-feed/unread-count')).unread);
    } catch {
      /* значок не критичен: при сбое остаётся прежнее число, панель покажет ошибку */
    }
  };
  useEffect(() => {
    void count();
    const t = setInterval(() => void count(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  const load = async (more: boolean, unreadOnly = onlyUnread) => {
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams({ limit: '20', ...(unreadOnly ? { unread: 'true' } : {}), ...(more && cursor ? { cursor } : {}) });
      const p = await browserCall<FeedPage>(`/staff-feed?${q}`);
      setItems((prev) => (more && prev ? [...prev, ...p.items] : p.items));
      setCursor(p.nextCursor);
      setUnread(p.unread);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load(false);
  };
  const filter = (v: boolean) => {
    setOnlyUnread(v);
    void load(false, v);
  };
  const go = async (e: MouseEvent, it: FeedItem) => {
    e.preventDefault();
    if (!it.read) await browserCall(`/staff-feed/${encodeURIComponent(it.id)}/read`, { method: 'POST' }).catch(() => undefined);
    location.assign(`${HREF[it.refType]}${encodeURIComponent(it.refId)}`);
  };
  const readAll = async () => {
    setBusy(true);
    setError('');
    try {
      await browserCall<{ marked: number }>('/staff-feed/read-all', { method: 'POST', body: { before: new Date().toISOString() } });
      setItems((prev) => (onlyUnread ? [] : (prev ?? []).map((x) => ({ ...x, read: true }))));
      if (onlyUnread) setCursor(null);
      await count();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const label = unread > 0 ? `События, непрочитанных: ${unread}` : 'События';
  return (
    <div ref={root} style="position:relative">
      <button class="yc-btn yc-btn--ghost" type="button" aria-label={label} aria-expanded={open} aria-controls="staff-feed" onClick={toggle}
        style="display:inline-flex;align-items:center;gap:var(--yc-sp-3xs)">
        События
        {unread > 0 && (
          <span data-testid="feed-badge" aria-hidden="true"
            style="min-width:1.4em;padding:0 .35em;border-radius:999px;background:var(--yc-danger);color:#fff;font-size:var(--yc-fs-xs);line-height:1.4em;text-align:center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <section id="staff-feed" aria-label="Лента событий" data-testid="staff-feed"
          style="position:absolute;z-index:30;right:0;top:calc(100% + 4px);width:min(26rem,calc(100vw - 32px));max-height:70vh;overflow:auto;background:var(--yc-surface);border:1px solid var(--yc-line);border-radius:var(--yc-r-m);box-shadow:0 8px 24px rgb(0 0 0 / .12);padding:var(--yc-sp-xs)">
          <div style="display:flex;flex-wrap:wrap;gap:var(--yc-sp-2xs);align-items:center;justify-content:space-between;margin-bottom:var(--yc-sp-2xs)">
            <label style="display:inline-flex;gap:var(--yc-sp-3xs);align-items:center;font-size:var(--yc-fs-xs)">
              <input type="checkbox" checked={onlyUnread} onChange={(e) => filter((e.target as HTMLInputElement).checked)} />
              Только непрочитанные
            </label>
            <button class="yc-link" type="button" disabled={busy || unread === 0} onClick={() => void readAll()}>Отметить все прочитанными</button>
          </div>
          {error && <p class="yc-alert yc-alert--error" role="alert" style="margin:0 0 var(--yc-sp-2xs)">{error}</p>}
          {items !== null && items.length === 0 && !error && (
            <p data-testid="feed-empty" style="margin:var(--yc-sp-2xs);color:var(--yc-muted)">{onlyUnread ? 'Непрочитанных событий нет.' : 'Событий пока нет.'}</p>
          )}
          {items !== null && items.length > 0 && (
            <ul style="list-style:none;margin:0;padding:0;display:grid;gap:var(--yc-sp-3xs)">
              {items.map((it) => (
                <li key={it.id} data-testid="feed-item" data-read={it.read ? 'true' : 'false'}>
                  <a href={`${HREF[it.refType]}${encodeURIComponent(it.refId)}`} onClick={(e) => void go(e as unknown as MouseEvent, it)}
                    style={`display:grid;gap:2px;padding:var(--yc-sp-2xs);border-radius:var(--yc-r-s);color:inherit;text-decoration:none;${it.read ? '' : 'background:var(--yc-accent-bg)'}`}>
                    <span style="font-size:var(--yc-fs-xs);color:var(--yc-muted)">
                      {KIND[it.kind]} · {it.branchName} · {when.format(new Date(it.occurredAt))}{it.read ? '' : ' · новое'}
                    </span>
                    <span style={it.read ? '' : 'font-weight:600'}>{it.title}</span>
                    {it.body && <span style="font-size:var(--yc-fs-xs)">{it.body}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <button class="yc-btn yc-btn--ghost" type="button" disabled={busy} onClick={() => void load(true)} style="margin-top:var(--yc-sp-2xs);width:100%">Показать ещё</button>
          )}
        </section>
      )}
    </div>
  );
}
