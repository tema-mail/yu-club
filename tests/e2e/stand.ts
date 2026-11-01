// Помощники e2e против живого стенда (S1-27): адреса из окружения, код входа клиента из лога API по ssh,
// клиент сайта через публичный API (кука yu_client в своём контексте), вход в CRM, SQL на стенде (только чтение).
// Пароли берутся из ~/.config/yu-club и никуда не печатаются. Нагрузки нет: всё последовательно, workers: 1.
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, request as pwRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

export const SITE_URL = process.env.SITE_URL ?? 'https://yu-club.45.12.72.227.nip.io';
export const CRM_URL = process.env.CRM_URL ?? 'https://yu-crm.45.12.72.227.nip.io';
const HOST = process.env.YU_HOST ?? 'root@45.12.72.227';
const KEY = process.env.YU_KEY ?? join(homedir(), '.ssh/omni_assistant_firstvds_ed25519');
const CFG = process.env.YU_CFG ?? join(homedir(), '.config/yu-club');
const API_CT = process.env.YU_API_CT ?? 'yu-club-api';
const PG_CT = process.env.YU_PG_CT ?? 'yu-club-postgres';

const secret = (name: string) => readFileSync(join(CFG, name), 'utf8').trim();
/** Демо-Администратор филиала Арбат (db/seed/dev.ts), пароль – ~/.config/yu-club/demo-pass. */
export const DEMO_ADMIN = { email: 'admin@demo.yu-club.test', password: () => secret('demo-pass') };
export const OWNER = { email: () => secret('admin-login'), password: () => secret('admin-pass') };

// ── ssh ─────────────────────────────────────────────────────
function ssh(command: string, input?: string): string {
  return execFileSync('ssh', ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', HOST, command], {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
  });
}

/** SQL на стенде (psql -At, только для проверок; запрос идёт через stdin). Строки – через «|». */
export function sql(query: string): string[] {
  const out = ssh(`docker exec -i ${PG_CT} psql -U postgres -d yu_club -At -v ON_ERROR_STOP=1`, query);
  return out.split('\n').filter((l) => l !== '');
}

/** Настройка K7 уровня филиала на стенде – через HTTP API настроек CRM (K7 «HTTP CRM») от имени Владельца:
 *  вход, текущий rowVersion из GET /settings, PUT с датой «сегодня по зоне филиала» (действует с этой минуты)
 *  или POST …/reset (value = null – вернуть к наследованию). Аудит пишет сам API (source crm). */
export async function branchSetting(key: string, branchId: string, value: unknown): Promise<void> {
  const api = await pwRequest.newContext({ baseURL: CRM_URL, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: CRM_URL } });
  try {
    const login = await api.post('/api/crm/v1/auth/login', { data: { email: OWNER.email(), password: OWNER.password() } });
    if (!login.ok()) throw await apiError(login);
    const q = `scope=branch&id=${encodeURIComponent(branchId)}`;
    const list = await api.get(`/api/crm/v1/settings?${q}`);
    if (!list.ok()) throw await apiError(list);
    const page = (await list.json()) as { scope: { today: string }; items: Array<{ key: string; rowVersion: string; source: { own: boolean } }> };
    const item = page.items.find((i) => i.key === key);
    expect(item, `настройка ${key} в API`).toBeTruthy();
    const headers = { 'idempotency-key': randomUUID() };
    const res =
      value === null
        ? await api.post(`/api/crm/v1/settings/${key}/reset?${q}`, { headers, data: { rowVersion: item!.rowVersion, reason: 'e2e S1-27: возврат к наследованию' } })
        : await api.put(`/api/crm/v1/settings/${key}?${q}`, { headers, data: { value, validFrom: page.scope.today, rowVersion: item!.rowVersion, reason: 'e2e S1-27' } });
    if (!res.ok()) throw await apiError(res);
  } finally {
    await api.dispose();
  }
}

// ── телефоны и код входа ────────────────────────────────────
/** Свой номер на каждый прогон: лимиты кода считаются по номеру (5 в час, пауза 60 с). */
export const randomPhone = () => `+7913${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
export const localPhone = (e164: string) => e164.slice(2); // 10 цифр для поля «Телефон»

/** Код из лога API: тестовый SMS-адаптер (APP_ENV=stage) пишет «[sms:dev] +7 ••• ••• ••-NN: Код для входа: 123456. …»
 *  (apps/api/src/modules/clients/otp.ts). Номер в логе маскирован – берём последнюю строку с его двумя цифрами. */
export async function otpCode(phoneE164: string, notBefore: string): Promise<string> {
  const tail = phoneE164.slice(-2);
  const re = new RegExp(`\\[sms:dev\\] \\+7 \\S+ \\S+ \\S+-${tail}: Код для входа: (\\d{6})`);
  for (let i = 0; i < 20; i++) {
    const lines = ssh(`docker logs ${API_CT} --since ${notBefore} 2>&1 | grep -F '[sms:dev]' || true`).split('\n');
    const hit = lines.map((l) => re.exec(l)?.[1]).filter(Boolean).at(-1);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`код для ••-${tail} не найден в логе ${API_CT}`);
}
/** Метка «с какого момента читать лог» – с запасом на расхождение часов мака и сервера. */
export const logMark = () => new Date(Date.now() - 30_000).toISOString().replace(/\.\d+Z$/, 'Z');

// ── клиент сайта через публичный API ────────────────────────
export interface HoldDto { id: string; status: string; items: Array<{ id: string; resourceId: string; start: string; end: string }>; owner: string }
export interface BookingDto { id: string; number: number; resourceId: string; resourceName: string; start: string; end: string; status: string; canCancel: boolean }
export interface Slot { start: string; end: string; state: 'free' | 'mine' | 'held' | 'booked' | 'blocked' | 'closed' }
export interface ApiErr { status: number; code: string }

export class SiteClient {
  readonly api: APIRequestContext;
  readonly phone: string;
  constructor(api: APIRequestContext, phone: string) {
    this.api = api;
    this.phone = phone;
  }

  private async send<T>(method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
    const q = path.indexOf('?');
    const url = `/api/public/v1${q < 0 ? `${path}/` : `${path.slice(0, q)}/${path.slice(q)}`}`;
    const res = method === 'GET'
      ? await this.api.get(url)
      : await this.api.post(url, { data: data ?? {}, headers: { 'idempotency-key': randomUUID(), 'x-requested-with': 'yu-site', origin: SITE_URL } });
    if (!res.ok()) throw await apiError(res);
    return (await res.json()) as T;
  }

  availability = (branchId: string, date: string) =>
    this.send<{ dayState: string; resources: Array<{ resourceId: string; slots: Slot[] }> }>('GET', `/branches/${branchId}/availability?date=${date}`);
  /** Удержание и подтверждение – одна бронь на каждый слот (встык одного ресурса сервер склеивает). */
  async book(branchId: string, items: Array<{ resourceId: string; start: string; end: string }>): Promise<BookingDto[]> {
    const hold = await this.send<HoldDto>('POST', '/holds', { branchId, items: items.slice(0, 1) });
    for (const it of items.slice(1)) await this.send<HoldDto>('POST', `/holds/${hold.id}/items`, it);
    try {
      return (await this.send<{ bookings: BookingDto[] }>('POST', `/holds/${hold.id}/confirm`)).bookings;
    } catch (e) {
      await this.release(hold.id).catch(() => undefined);
      throw e;
    }
  }
  hold = (branchId: string, item: { resourceId: string; start: string; end: string }) => this.send<HoldDto>('POST', '/holds', { branchId, items: [item] });
  release = (holdId: string) => this.send<HoldDto>('POST', `/holds/${holdId}/release`);
  cancel = (bookingId: string) => this.send<BookingDto>('POST', `/bookings/${bookingId}/cancel`);
  my = (tab: 'upcoming' | 'past' | 'cancelled') => this.send<{ items: BookingDto[] }>('GET', `/me/bookings?tab=${tab}`);
  /** Уборка: отменить свои будущие брони из списка (ошибки не роняют тест – он уже отработал). */
  async cleanup(ids: string[]): Promise<void> {
    const live = new Map((await this.my('upcoming')).items.map((b) => [b.id, b]));
    for (const id of ids) if (live.get(id)?.canCancel) await this.cancel(id).catch(() => undefined);
  }
  dispose = () => this.api.dispose();
}

export async function apiError(res: APIResponse): Promise<ApiErr & Error> {
  let code = 'UNKNOWN';
  try {
    code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code;
  } catch {
    // не JSON
  }
  return Object.assign(new Error(`${res.status()} ${code}`), { status: res.status(), code });
}

export const siteContext = () =>
  pwRequest.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'x-requested-with': 'yu-site', origin: SITE_URL } });

/** Новый клиент по коду (номер – свой на прогон): запрос кода, код из лога, вход с согласием на ПДн. */
export async function newClient(phone = randomPhone()): Promise<SiteClient> {
  const api = await siteContext();
  const mark = logMark();
  const req = await api.post('/api/public/v1/auth/otp/request/', { data: { phone, purpose: 'login' }, headers: { 'idempotency-key': randomUUID() } });
  if (req.status() !== 202) throw await apiError(req);
  const { challengeId } = (await req.json()) as { challengeId: string };
  const code = await otpCode(phone, mark);
  const ver = await api.post('/api/public/v1/auth/otp/verify/', {
    data: { challengeId, code, consents: { pdProcessing: true } }, headers: { 'idempotency-key': randomUUID() },
  });
  if (!ver.ok()) throw await apiError(ver);
  return new SiteClient(api, phone);
}

// ── сеть стенда ─────────────────────────────────────────────
export interface StandBranch { id: string; slug: string; citySlug: string; name: string; timezone: string }
export interface StandResource { id: string; name: string; type: string; zone: string; stepMinutes: number; roomId: string | null; roomSlug: string | null }

export async function branchBySlug(api: APIRequestContext, citySlug: string, slug: string): Promise<StandBranch> {
  const cities = ((await (await api.get('/api/public/v1/cities/')).json()) as { items: Array<{ id: string; slug: string }> }).items;
  const city = cities.find((c) => c.slug === citySlug);
  expect(city, `город ${citySlug} на стенде`).toBeTruthy();
  const branches = ((await (await api.get(`/api/public/v1/branches/?city=${citySlug}`)).json()) as { items: Array<StandBranch & { cityId: string }> }).items;
  const b = branches.find((x) => x.slug === slug);
  expect(b, `филиал ${citySlug}/${slug} на стенде`).toBeTruthy();
  return { id: b!.id, slug: b!.slug, citySlug, name: b!.name, timezone: b!.timezone };
}

export async function resourcesOf(api: APIRequestContext, branchId: string): Promise<StandResource[]> {
  return ((await (await api.get(`/api/public/v1/branches/${branchId}/resources/`)).json()) as { items: StandResource[] }).items;
}

// ── время филиала ───────────────────────────────────────────
/** Сегодня в зоне филиала + n дней, 'YYYY-MM-DD'. */
export function dayIn(tz: string, n: number): string {
  const base = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** Местное время филиала → ISO UTC (смещение зоны на эту дату). */
export function at(date: string, hm: string, tz: string): string {
  const guess = Date.parse(`${date}T${hm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess));
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  const shown = Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:00Z`);
  return new Date(guess - (shown - guess)).toISOString();
}
export const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

/** Острова Astro ожили: пока у astro-island есть атрибут ssr, клики по кнопкам острова ничего не делают. */
export async function hydrated(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
}

// ── CRM ─────────────────────────────────────────────────────
export async function crmLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${CRM_URL}/login`);
  await page.getByLabel('Почта').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
