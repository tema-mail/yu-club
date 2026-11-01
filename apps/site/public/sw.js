// Service worker сайта Ю-Клуб: только Web Push (S1-16, Q-30). Кэша страниц нет – данные всегда с сервера.
// Тело push – JSON { title, body, url, tag, id } от API (modules/notifications/sender.ts), уже расшифрованное браузером.
// tag = Topic уведомления: повтор того же этапа заменяет показанное, а не дублирует.
/* global self, clients, URL, fetch, atob */
'use strict';

const API = '/api/public/v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

function sameOriginPath(url) {
  try {
    const u = new URL(url || '/account/', self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/account/';
  } catch {
    return '/account/';
  }
}

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Ю-Клуб';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    renotify: false,
    lang: 'ru',
    data: { url: sameOriginPath(data.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = sameOriginPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          await c.focus();
          if ('navigate' in c) await c.navigate(path);
          return;
        }
      }
      await clients.openWindow(path);
    })(),
  );
});

// Браузер сменил подписку (истекла, ключи обновлены): подписаться заново тем же ключом VAPID и сообщить серверу (K9).
// Старую сервер отзовёт сам по 404/410 при следующей отправке. Нет сессии (401) – lib/push.ts сохранит её после входа.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription;
      if (!sub) {
        const res = await fetch(`${API}/push/vapid-public-key/`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const { publicKey } = await res.json();
        const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'));
        const key = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch(`${API}/me/push-subscriptions/`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'yu-site' },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
