// Подписка на Web Push в браузере (S1-15, Q-30) – для островов ЛК (/account/profile/, блок «Уведомления»).
// Только в браузере: вызывать из обработчиков событий острова, не при SSR. Запросы – на свой origin
// (/api/public/v1, кука yu_client); без сессии API отвечает 401 AUTH_REQUIRED.
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
  return fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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

async function saveOnServer(sub: PushSubscription): Promise<void> {
  const res = await api('/push/subscription', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
  if (!res.ok) throw new Error(`push: сервер не сохранил подписку – HTTP ${res.status}`);
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
    await api('/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }
  return 'off';
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const res = await api('/notification-settings');
  if (!res.ok) throw new Error(`notification-settings: HTTP ${res.status}`);
  return (await res.json()) as NotificationSettings;
}

/** «Напоминания» и «Реклама» (09 §5). Включение рекламы = согласие с текстом версии documentVersion. */
export async function saveNotificationSettings(
  value: { remindersEnabled: boolean; marketingEnabled: boolean; documentVersion?: string },
  idempotencyKey: string = crypto.randomUUID(),
): Promise<NotificationSettings> {
  const res = await api('/notification-settings', { method: 'PUT', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error(`notification-settings: HTTP ${res.status}`);
  return (await res.json()) as NotificationSettings;
}
