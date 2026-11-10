// S4-123. Центр уведомлений ЛК (09 §11, K21 §3, K5 №201–204). Открыть центр – не значит прочитать: прочтение – по нажатию на сообщение
// или «Отметить все прочитанными». Состояние связанной записи – словами (09 §11.2): отменённая, завершённая, недоступная; переход к
// недоступной записи не делаем. Новое отмечено словом «Новое», а не только цветом. Число непрочитанных – событием UNREAD_EVENT для значка.
import { useEffect, useState } from 'preact/hooks';
import { API_PREFIX } from '../lib/api.ts';
import { ClientApiError, browserCall, errorText } from '../lib/client.ts';
import type { InboxItem, InboxPage } from '../lib/inbox.ts';

export const UNREAD_EVENT = 'yu:unread';

const CATEGORY: Record<InboxItem['category'], string> = { service: 'Запись', reminder: 'Напоминание', marketing: 'Акции и новости' };
const BOOKING: Record<string, string> = { cancelled: 'Связано с отменённой записью', finished: 'Запись уже прошла', unavailable: 'Запись недоступна' };
const when = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
/** Только путь своего сайта (url проверен API, CHECK 0111) – повторяем проверку на всякий случай. */
const internal = (u: string | null) => (u && u.startsWith('/') && !u.startsWith('//') && !u.includes('\\') ? u : null);

async function page(cursor: string | null): Promise<InboxPage> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}/me/notifications/?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  } catch {
    throw new ClientApiError(0, 'NETWORK', '');
  }
  if (!res.ok) throw new ClientApiError(res.status, res.status >= 500 ? 'INTERNAL' : 'ERROR', '');
  return (await res.json()) as InboxPage;
}

const announce = (unread: number) => window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: unread }));

export default function NotificationCenter() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(more = false) {
    setError('');
    setBusy(true);
    try {
      const p = await page(more ? cursor : null);
      setItems((prev) => (more && prev ? [...prev, ...p.items] : p.items));
      setCursor(p.nextCursor);
      setUnread(p.unread);
      announce(p.unread);
    } catch (e) {
      if (e instanceof ClientApiError && e.status === 401) return location.assign(`/login/?next=${encodeURIComponent('/account/notifications/')}`);
      setError(`Не удалось загрузить уведомления. ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function open(item: InboxItem) {
    setError('');
    if (!item.read) {
      try {
        await browserCall<void>(`/me/notifications/${item.id}/read`, {});
        setItems((list) => list?.map((x) => (x.id === item.id ? { ...x, read: true } : x)) ?? null);
        setUnread((n) => {
          announce(Math.max(0, n - 1));
          return Math.max(0, n - 1);
        });
      } catch (e) {
        setError(`Не удалось отметить прочитанным. ${errorText(e)}`);
        return;
      }
    }
    const to = internal(item.url);
    if (to && item.booking?.state !== 'unavailable') location.assign(to);
  }

  async function readAll() {
    setBusy(true);
    setError('');
    try {
      await browserCall<{ marked: number }>('/me/notifications/read-all', { before: new Date().toISOString() });
      setItems((list) => list?.map((x) => ({ ...x, read: true })) ?? null);
      setUnread(0);
      announce(0);
    } catch (e) {
      setError(`Не удалось отметить все. ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="yu-account__block nc" aria-labelledby="nc-title" data-testid="notification-center">
      <div class="nc__head">
        <h2 id="nc-title">Сообщения</h2>
        {unread > 0 && <button class="yu-btn yu-btn--ghost yu-btn--small" type="button" disabled={busy} onClick={() => void readAll()}>Отметить все прочитанными</button>}
      </div>
      <p class="yu-alert" role="alert">{error}</p>
      {error && items === null && <button class="yu-btn yu-btn--ghost" type="button" onClick={() => void load()}>Повторить</button>}
      {items === null && !error && <p role="status">Загружаем…</p>}
      {items?.length === 0 && <p class="yu-body" data-testid="nc-empty">Уведомлений пока нет. Здесь появятся подтверждения, изменения записей и напоминания.</p>}
      {items && items.length > 0 && (
        <ul class="nc__list">
          {items.map((it) => (
            <li key={it.id} class={`nc__item${it.read ? '' : ' nc__item--new'}`} data-testid="nc-item" data-id={it.id}>
              <button class="nc__open" type="button" onClick={() => void open(it)}>
                <span class="nc__meta">
                  {!it.read && <span class="nc__new">Новое</span>}
                  <span>{CATEGORY[it.category]}</span>
                  <time dateTime={it.at}>{when(it.at)}</time>
                </span>
                <span class="nc__title">{it.title}</span>
                <span class="nc__body">{it.body}</span>
                {it.booking && BOOKING[it.booking.state] && <span class="nc__booking" data-testid="nc-booking">{BOOKING[it.booking.state]}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor && <button class="yu-btn yu-btn--ghost" type="button" disabled={busy} onClick={() => void load(true)}>Показать ещё</button>}
    </section>
  );
}
