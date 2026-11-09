// Service worker сайта Ю-Клуб: только Web Push (S1-16, Q-30). Кэша страниц нет – данные всегда с сервера.
// Тело push – JSON { title, body, url, tag, id } от API (modules/notifications/sender.ts), уже расшифрованное браузером.
// tag = Topic уведомления: повтор того же этапа заменяет показанное, а не дублирует.
// S4-125 (K21 §3, §4): переход добавляет ?n=<id> – страница отмечает прочтение (UnreadBadge); у рекламы – кнопка «Отписаться от акций»
// (actions + unsubscribeUrl от sender.ts): POST /unsubscribe с X-Requested-With: yu-site (браузер ставит свой Origin – прокси сайта пропускает);
// не вышло – открываем страницу /unsubscribe/?t=… с кнопкой.
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
    data: {
      url: sameOriginPath(data.url),
      id: typeof data.id === 'string' ? data.id : null,
      unsubscribeUrl: typeof data.unsubscribeUrl === 'string' ? sameOriginPath(data.unsubscribeUrl) : null,
    },
  };
  if (Array.isArray(data.actions) && options.data.unsubscribeUrl) {
    options.actions = data.actions.filter((a) => a && a.action === 'unsubscribe').map((a) => ({ action: 'unsubscribe', title: String(a.title || 'Отписаться от акций') }));
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Отписка из push: токен – параметр t адреса отписки. true – отписан. */
async function unsubscribe(unsubscribeUrl) {
  const t = new URL(unsubscribeUrl, self.location.origin).searchParams.get('t');
  if (!t) return false;
  try {
    const res = await fetch(`${API}/unsubscribe/`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'yu-site' },
      body: JSON.stringify({ t }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Адрес перехода с ?n=<id>: страница ЛК отметит прочтение. */
function withRead(path, id) {
  if (!id) return path;
  const u = new URL(path, self.location.origin);
  u.searchParams.set('n', id);
  return u.pathname + u.search + u.hash;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action === 'unsubscribe' && data.unsubscribeUrl) {
    event.waitUntil(
      (async () => {
        if (await unsubscribe(data.unsubscribeUrl)) {
          await self.registration.showNotification('Ю-Клуб', { body: 'Вы отписались от рекламы и акций. Сообщения о записях будут приходить.', lang: 'ru', tag: 'unsubscribed' });
        } else {
          await clients.openWindow(data.unsubscribeUrl);
        }
      })(),
    );
    return;
  }
  const path = withRead(sameOriginPath(data.url), data.id);
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
