// Подписка на Web Push в браузере (S1-15, Q-30) – для островов ЛК (/account/profile/, блок «Уведомления»).
// Только в браузере: вызывать из обработчиков событий острова, не при SSR. Запросы – на свой origin через прокси
// сайта (/api/public/v1/*, кука yu_client, слеш в конце – trailingSlash сайта); изменяющие – с X-Requested-With: yu-site
// (CSRF-проверка прокси). Пути – K9: /me/push-subscriptions, /me/notification-settings. Без сессии – 401 AUTH_REQUIRED.
// Разрешение браузера спрашивать только по нажатию кнопки (Notification.requestPermission требует жеста).
// Без разрешения уведомления не теряются: сервисные остаются записью в ЛК со статусом «нет канала» (09 §10).

const API = '/api/public/v1';
const SW_URL = '/sw.js';

export type PushState =
  | 'unsupported' // нет Service Worker / PushManager (старый браузер, iOS вне «На экран Домой»)
  | 'not_configured' // на сервере нет ключей VAPID (503 PUSH_NOT_CONFIGURED)
  | 'denied' // клиент запретил уведомления в браузере – включить можно только в настройках браузера
  | 'off' // можно включить
  | 'on'; // подписка есть и сохранена

export interface NotificationSettings {
  remindersEnabled: boolean;
  marketingEnabled: boolean;
  serviceAlwaysOn: true;
  pushSubscriptions: number;
}

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const write = init.method !== undefined && init.method !== 'GET';
  return fetch(`${API}${path}/`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(write ? { 'content-type': 'application/json', 'x-requested-with': 'yu-site' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function vapidKey(): Promise<string | null> {
  const res = await api('/push/vapid-public-key');
  if (res.status === 503) return null;
  if (!res.ok) throw new Error(`push: ключ VAPID – HTTP ${res.status}`);
  return ((await res.json()) as { publicKey: string }).publicKey;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration(SW_URL)) ?? navigator.serviceWorker.register(SW_URL, { scope: '/' });
}

/** POST идемпотентен: повтор той же подписки возвращает тот же id (200), новая – 201. */
async function saveOnServer(sub: PushSubscription): Promise<string> {
  const res = await api('/me/push-subscriptions', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  if (!res.ok) throw new Error(`push: сервер не сохранил подписку – HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Текущее состояние без вопросов пользователю. Есть подписка в браузере – заодно сверяет её с сервером (после входа). */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return (await vapidKey()) ? 'off' : 'not_configured';
  await saveOnServer(sub).catch(() => undefined); // повтор идемпотентен: 200 с тем же id
  return 'on';
}

/** Включить: по нажатию кнопки. Спрашивает разрешение, подписывается ключом VAPID сервера, сохраняет подписку. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const key = await vapidKey();
  if (!key) return 'not_configured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) }));
  await saveOnServer(sub);
  return 'on';
}

/** Выключить на этом устройстве: отписка в браузере и на сервере (DELETE идемпотентен – 204). */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    // id подписки на сервере – из идемпотентного POST; DELETE /{id} всегда 204 (K9).
    const id = await saveOnServer(sub).catch(() => null);
    if (id) await api(`/me/push-subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await sub.unsubscribe();
  }
  return 'off';
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const res = await api('/me/notification-settings');
  if (!res.ok) throw new Error(`notification-settings: HTTP ${res.status}`);
  return (await res.json()) as NotificationSettings;
}

/** «Напоминания» и «Реклама» (09 §5). Включение рекламы = согласие с текстом версии documentVersion. */
export async function saveNotificationSettings(
  value: { remindersEnabled: boolean; marketingEnabled: boolean; documentVersion?: string },
  idempotencyKey: string = crypto.randomUUID(),
): Promise<NotificationSettings> {
  const res = await api('/me/notification-settings', { method: 'PUT', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error(`notification-settings: HTTP ${res.status}`);
  return (await res.json()) as NotificationSettings;
}
