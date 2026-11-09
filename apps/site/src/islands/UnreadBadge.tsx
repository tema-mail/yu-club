// S4-124. Значок непрочитанных в шапке (K21 §3, K5 №202–203). Рисуется только при куке сессии (Site.astro) – без неё запроса нет.
// Открытие из push: адрес с ?n=<id> (service worker) – отмечаем прочтение этого сообщения и убираем параметр из адреса (K21 §3: показ push
// в браузере недостоверен, прочтение – по переходу). Центр уведомлений сообщает новое число событием UNREAD_EVENT.
import { useEffect, useState } from 'preact/hooks';
import { API_PREFIX } from '../lib/api.ts';
import { browserCall } from '../lib/client.ts';
import { UNREAD_EVENT } from './NotificationCenter.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function count(): Promise<number | null> {
  try {
    const res = await fetch(`${API_PREFIX}/me/notifications/unread-count/`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as { unread: number }).unread : null;
  } catch {
    return null;
  }
}

export default function UnreadBadge() {
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    const onEvent = (e: Event) => setUnread((e as CustomEvent<number>).detail);
    window.addEventListener(UNREAD_EVENT, onEvent);
    void (async () => {
      const url = new URL(location.href);
      const n = url.searchParams.get('n');
      if (n !== null) {
        url.searchParams.delete('n');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
        // Чужое, скрытое или уже удалённое – 404: просто показываем текущее число.
        if (UUID.test(n)) await browserCall<void>(`/me/notifications/${n}/read`, {}).catch(() => undefined);
      }
      const c = await count();
      if (c !== null) setUnread(c);
    })();
    return () => window.removeEventListener(UNREAD_EVENT, onEvent);
  }, []);

  const label = unread ? `Уведомления: ${unread} непрочитанных` : 'Уведомления';
  return (
    <a class="yu-bell" href="/account/notifications/" aria-label={label} title={label} data-testid="unread-badge">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
      </svg>
      {unread ? <span class="yu-bell__count" data-testid="unread-count">{unread > 99 ? '99+' : unread}</span> : null}
    </a>
  );
}
