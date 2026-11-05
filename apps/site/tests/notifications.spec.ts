// e2e блока «Уведомления» в ЛК (K9 /me/notification-settings, /me/push-subscriptions) на моке tests/mock-api.ts.
// Настоящей подписки в headless Chromium нет (нет push-сервиса): PushManager и Notification подменяются до загрузки страницы;
// service worker /sw.js регистрируется по-настоящему.
import { expect, test, type Page } from '../../../tests/support/e2e.ts';
import { MOCK_PORT, STAGE_PORT } from '../playwright.config.ts';
import { MOCK_CODE } from './mock-api.ts';

test.use({ baseURL: `http://localhost:${STAGE_PORT}` });

async function login(page: Page, phone: string) {
  await page.goto('/login/?next=%2Faccount%2F');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из SMS').fill(MOCK_CODE);
  await page.getByLabel(/согласие на обработку/).check();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/account\/$/);
}

/** Подмена браузерного push: разрешение даётся, subscribe возвращает фейковую подписку FCM. */
const FAKE_PUSH = () => {
  const w = window as unknown as Record<string, unknown>;
  let permission: NotificationPermission = 'default';
  let sub: unknown = null;
  const fake = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device', expirationTime: null, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }),
    unsubscribe: async () => {
      sub = null;
      return true;
    },
  };
  Object.defineProperty(Notification, 'permission', { get: () => permission });
  Notification.requestPermission = async () => {
    permission = 'granted';
    return permission;
  };
  const proto = (w.PushManager as { prototype: Record<string, unknown> }).prototype;
  proto.getSubscription = async () => sub;
  proto.subscribe = async () => {
    sub = fake;
    return fake;
  };
};

test('переключатели: выключить напоминания и включить рекламу – сохраняется на сервере, после перезагрузки так же', async ({ page }) => {
  await login(page, '9135550001');
  const block = page.getByTestId('notifications');
  await expect(block).toContainText('приходят всегда');
  const reminders = block.getByLabel(/Напоминания о сеансе/);
  const marketing = block.getByLabel(/Реклама и акции/);
  await expect(reminders).toBeChecked();
  await expect(marketing).not.toBeChecked();
  await reminders.uncheck();
  await expect(reminders).toBeEnabled();
  await marketing.check();
  await expect(marketing).toBeEnabled();
  await page.reload();
  await expect(block.getByLabel(/Напоминания о сеансе/)).not.toBeChecked();
  await expect(block.getByLabel(/Реклама и акции/)).toBeChecked();
});

test('ошибка сохранения – переключатель возвращается и видна причина', async ({ page }) => {
  await login(page, '9135550500');
  const reminders = page.getByLabel(/Напоминания о сеансе/);
  await reminders.uncheck();
  await expect(page.getByTestId('notifications').getByRole('alert').first()).toContainText('Не удалось сохранить');
  await expect(reminders).toBeChecked();
});

test('браузер без push – понятная фраза и без кнопки', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).PushManager;
  });
  await login(page, '9135550002');
  await expect(page.getByTestId('push-state')).toContainText('не умеет показывать уведомления');
  await expect(page.getByRole('button', { name: /Включить уведомления/ })).toHaveCount(0);
});

test('уведомления запрещены в браузере – подсказка, где разрешить', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
  });
  await login(page, '9135550003');
  await expect(page.getByTestId('push-state')).toContainText('запрещены в настройках браузера');
});

test('включить по нажатию: регистрация /sw.js, подписка уходит на сервер; выключить – DELETE по endpoint', async ({ page, request }) => {
  await page.addInitScript(FAKE_PUSH);
  await login(page, '9135550004');
  await expect(page.getByTestId('push-state')).toContainText('выключены');
  await page.getByRole('button', { name: 'Включить уведомления в браузере' }).click();
  await expect(page.getByTestId('push-state')).toContainText('включены');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/sw.js'))?.active?.scriptURL ?? null);
  expect(scope).toMatch(/\/sw\.js$/);

  await page.getByRole('button', { name: 'Выключить в этом браузере' }).click();
  await expect(page.getByTestId('push-state')).toContainText('выключены');
  const calls = (await (await request.get(`http://127.0.0.1:${MOCK_PORT}/__test/push-calls`)).json()) as Array<{ method: string; body: { endpoint: string } }>;
  const mine = calls.filter((c) => c.body.endpoint.endsWith('/e2e-device'));
  expect(mine.map((c) => c.method)).toEqual(['POST', 'DELETE']);
});
