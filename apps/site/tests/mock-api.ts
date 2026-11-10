// Мок публичного API для e2e сайта (вход и ЛК – tests/mock-clients.ts, ресурсы – tests/mock-resources.ts, баллы и
// сертификаты – tests/mock-commerce.ts). Сеть – точно по apps/api/src/modules/network/routes.public.ts (K5 №1–4:
// города, филиалы, филиал с hoursToday, ресурсы; id – UUID, не-UUID и закрытые статусы – одинаковый 404);
// тело ошибки – ADR 0002; статусы – K13. Запись (K5 №5–12) – точно по apps/api/src/modules/booking/routes.public.ts,
// hold.ts, confirm.ts: см. registerBooking ниже.
// Филиалы 'preparing'/'archived' лежат в данных, но наружу не отдаются (K5) – так e2e проверяет 404.
// Запуск: MOCK_PORT=4020 node tests/mock-api.ts; сайт: API_URL=http://127.0.0.1:4020.
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import * as K from '../../../packages/contracts/src/booking.ts';
import { MOCK_CODE, UUID, clients, fail, readCookie, registerClientAuth, sessions } from './mock-clients.ts';
import { registerCommerce } from './mock-commerce.ts';
import { registerContent } from './mock-content.ts';
import { registerNotifications } from './mock-notifications.ts';
import { registerEvents } from './mock-events.ts';
import { registerResources, resourceId, seedResources } from './mock-resources.ts';

export { MOCK_CODE, resourceId };

type Status = 'preparing' | 'active' | 'temporarily_closed' | 'archived';

const cities = [
  { id: '0b0c0000-0000-4000-8000-000000000001', slug: 'novosibirsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' },
  { id: '0b0c0000-0000-4000-8000-000000000002', slug: 'tomsk', name: 'Томск', timezone: 'Asia/Tomsk' },
  // Только готовящийся филиал – города в публичном списке нет.
  { id: '0b0c0000-0000-4000-8000-000000000003', slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' },
];

// hoursToday – как отдаёт API ('HH:mm' по зоне филиала); у «Красного» сегодня выходной – страница пишет «закрыто сегодня».
const HOURS: Record<string, Array<{ start: string; end: string }>> = {
  '0b0b0000-0000-4000-8000-000000000021': [{ start: '10:00', end: '22:00' }],
};

const branches: Array<{ id: string; cityId: string; slug: string; name: string; address: string; timezone: string; status: Status; phone: string | null }> = [
  { id: '0b0b0000-0000-4000-8000-000000000011', cityId: '0b0c0000-0000-4000-8000-000000000001', slug: 'krasny-prospekt', name: 'Ю-Клуб на Красном', address: 'Красный проспект, 25', timezone: 'Asia/Novosibirsk', status: 'active', phone: null },
  { id: '0b0b0000-0000-4000-8000-000000000012', cityId: '0b0c0000-0000-4000-8000-000000000001', slug: 'akademgorodok', name: 'Ю-Клуб Академгородок', address: 'Морской проспект, 2', timezone: 'Asia/Novosibirsk', status: 'temporarily_closed', phone: null },
  { id: '0b0b0000-0000-4000-8000-000000000013', cityId: '0b0c0000-0000-4000-8000-000000000001', slug: 'gorskiy', name: 'Ю-Клуб Горский', address: 'Горский микрорайон, 8', timezone: 'Asia/Novosibirsk', status: 'preparing', phone: null },
  { id: '0b0b0000-0000-4000-8000-000000000021', cityId: '0b0c0000-0000-4000-8000-000000000002', slug: 'lenina', name: 'Ю-Клуб на Ленина', address: 'проспект Ленина, 80', timezone: 'Asia/Tomsk', status: 'active', phone: null },
  { id: '0b0b0000-0000-4000-8000-000000000031', cityId: '0b0c0000-0000-4000-8000-000000000003', slug: 'mira', name: 'Ю-Клуб на Мира', address: 'проспект Мира, 5', timezone: 'Asia/Omsk', status: 'preparing', phone: null },
];

const isPublic = (s: Status) => s === 'active' || s === 'temporarily_closed';
const publicBranches = () => branches.filter((b) => isPublic(b.status));

function toDto(b: (typeof branches)[number]) {
  const { id, cityId, slug, name, address, timezone, status, phone } = b;
  return { id, cityId, slug, name, address, timezone, status, phone, publicContacts: {}, bookingWindow: { defaultDays: 7, maxDays: 30 }, holdMinutes: 15 };
}



// История адресов K23 §5: что вернул бы resolveLegacyPath (тот же разбор проверен на настоящем API, tests/content/paths.test.ts).
const LEGACY: Record<string, string> = {
  '/old-nsk/': '/novosibirsk/',
  '/old-nsk/krasny-prospekt/': '/novosibirsk/krasny-prospekt/',
  '/old-nsk/krasny-prospekt/rooms/': '/novosibirsk/krasny-prospekt/#rooms',
  '/tomsk/old-lenina/': '/tomsk/lenina/',
  '/old-tomsk/': '/tomsk/lenina/',
  '/novosibirsk/closed-club/': '/novosibirsk/',
  '/tomsk/closed-club/': '/contacts/',
  '/tomsk/lenina/rooms/hidden-room/': '/tomsk/lenina/',
};

export function buildMock() {
  const app = Fastify({ logger: false });
  const P = '/api/public/v1';

  // K5 №217: черновик, снятое и архив сюда не попадают (проверено на настоящем API, tests/content/redirects.routes.test.ts).
  // Страниц /news/ и /games/ на сайте пока нет: их адреса не должны попасть в карту, пока не появятся файлы страниц.
  // Переключатель сбоя для sitemap.spec.ts: API молчит – карта отвечает 503, а не урезанным списком.
  let sitemapDown = false;
  app.post('/__mock/sitemap-down', async (request) => {
    sitemapDown = (request.body as { down: boolean }).down;
    return { down: sitemapDown };
  });
  app.get(`${P}/seo/sitemap-entries`, async (_request, reply) => {
    if (sitemapDown) return reply.code(500).send({ error: { code: 'INTERNAL', message: 'сбой' } });
    reply.header('cache-control', 'public, max-age=60');
    return {
      items: [
        { path: '/rules/', title: 'Правила клуба', lastmod: '2026-11-01T10:00:00.000Z' },
        { path: '/novosibirsk/krasny-prospekt/', title: null, lastmod: '2026-11-02T10:00:00.000Z' },
        { path: '/news/live-news/', title: 'Живая новость', lastmod: '2026-11-03T10:00:00.000Z' },
        { path: '/games/vr/alyx/', title: 'Half-Life: Alyx', lastmod: '2026-11-03T10:00:00.000Z' },
        // Живые турниры mock-content.ts; завершённый (spring-cup), отложенный и черновик API в карту не отдаёт – с ними хаб /tournaments/ входит в карту (K23 §2).
        { path: '/tournaments/cs2-cup-december/', title: 'Кубок сети по Counter-Strike 2', lastmod: '2026-11-06T10:00:00.000Z' },
        { path: '/tournaments/dota-autumn/', title: 'Осенний турнир по Dota 2', lastmod: '2026-11-05T10:00:00.000Z' },
        { path: '/tournaments/fifa-lenina/', title: 'FIFA на Ленина', lastmod: '2026-11-08T10:00:00.000Z' },
      ],
    };
  });

  app.get(`${P}/redirects/resolve`, async (request, reply) => {
    const { path } = request.query as { path?: string };
    if (path === '/api-down/' || path === '/api-down/x/') return reply.code(500).send({ error: { code: 'INTERNAL', message: 'сбой' } });
    const location = path ? LEGACY[path] : undefined;
    reply.header('cache-control', 'public, max-age=60');
    if (!location) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    return { location };
  });

  // Черновик для предпросмотра (K22 §11, S4-43): только с секретом и токеном; в тексте – атака, очистка на стороне сайта.
  app.get('/api/internal/v1/content/preview/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    if (request.headers['x-preview-secret'] !== process.env.MOCK_PREVIEW_SECRET || token !== 'draft-token') return reply.code(404).send({ error: { code: 'PREVIEW_TOKEN_INVALID', message: 'Не найдено' } });
    const media = 'aaaaaaaa-0000-4000-8000-000000000001';
    return {
      entityType: 'publication',
      entityId: 'cccccccc-0000-4000-8000-000000000001',
      branchId: null,
      kind: 'news',
      draft: {
        title: 'Заголовок черновика',
        lead: 'Подводка',
        coverMediaId: media,
        body: `ТЕКСТ-ЧЕРНОВИКА <script>window.hacked = true</script> <img src=x onerror="window.hacked = true"> [чужая](//evil.ru) [плохая](javascript:alert(1)) ![подмена](media:${media})`,
      },
      media: { [media]: { removed: false, alt: 'Зал из снимка', width: 1600, height: 900, url: '/media/aa/bb/x-1600.webp', variants: [{ w: 1600, h: 900, format: 'webp', url: '/media/aa/bb/x-1600.webp' }] } },
    };
  });

  app.get(`${P}/cities`, async () => ({
    items: cities.filter((c) => publicBranches().some((b) => b.cityId === c.id)),
  }));

  app.get(`${P}/branches`, async (req) => {
    const { city } = req.query as { city?: string };
    const c = city ? cities.find((x) => x.slug === city) : null;
    const items = publicBranches().filter((b) => !city || b.cityId === c?.id);
    return { items: items.map(toDto) };
  });

  app.get(`${P}/branches/:id`, async (req, reply) => {
    const b = publicBranches().find((x) => x.id === (req.params as { id: string }).id);
    if (!b) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    // Временно закрытый – API отдаёт пустые часы (tempClosed действует сейчас).
    return { ...toDto(b), hoursToday: b.status === 'active' ? (HOURS[b.id] ?? []) : [], weeklyHours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, open: '10:00', close: '22:00' })) };
  });

  registerResources(app, P, (id) => publicBranches().some((b) => b.id === id), fail);
  registerContent(app, P, { // контент Э4 (K5 №207–215) – tests/mock-content.ts
    branchCity: (id) => branches.find((b) => b.id === id)?.cityId,
    cityBranches: (id) => branches.filter((b) => b.cityId === id).map((b) => b.id),
    fail,
  });


  registerClientAuth(app, P, (clientId, cookie) => attachVisitorHolds(clientId, visitorOf(cookie))); // хук входа K9 → booking (server.ts)
  registerCommerce(app, P, { // баллы и сертификаты (Э2) – tests/mock-commerce.ts; до записи: ворота −50 на POST /holds
    sessionClient: (cookie) => {
      const c = clients.find((x) => x.id === clientOf(cookie));
      return c ? { id: c.id, phone: c.phone } : null;
    },
    holdView: (id) => {
      const h = holds.get(id);
      if (!h) return null;
      const items = h.items.filter((i) => i.status === 'active').map((i) => ({ id: i.id, minutes: (i.end - i.start) / MIN, type: findResource(i.resourceId)!.type }));
      return { clientId: h.clientId, live: isLive(h, Date.now()), items };
    },
    fail,
  });
  registerBooking(app, P);
  registerNotifications(app, P); // центр уведомлений и отписка (K21 §11) – tests/mock-notifications.ts
  registerEvents(app, P, { // мероприятия и подарок (Э3) – tests/mock-events.ts; запись по подарку – обычное удержание K5 ниже
    sessionClient: (cookie) => {
      const c = clients.find((x) => x.id === clientOf(cookie));
      return c ? { id: c.id, phone: c.phone } : null;
    },
    branches: () => publicBranches().map((b) => ({ id: b.id, name: b.name, timezone: b.timezone, active: b.status === 'active', hasRoom: resourcesOf(b.id).some((r) => r.type === 'room_whole') })),
    giftWindows,
    giftHold,
    holdState: (id) => {
      const h = holds.get(id);
      if (!h) return { state: 'dead', bookingId: null };
      if (h.status === 'converted') return { state: 'converted', bookingId: bookings.find((b) => b.checkoutId === (h.checkout as { checkoutId: string }).checkoutId)?.id ?? null };
      return { state: isLive(h, Date.now()) ? 'live' : 'dead', bookingId: null };
    },
    fail,
  });
  return app;
}


// ---- Запись (K5 №5–12) – по apps/api/src/modules/booking: availability.ts (6 состояний слота), hold.ts (общий таймер,
// добавление перезапускает его, удаление последней позиции закрывает удержание, attach при входе), confirm.ts (позиции
// одного ресурса встык – одна бронь, повтор переведённого удержания – прежний результат), идемпотентность по ключу.
// Часы: Новосибирск и Томск – UTC+7 без перехода. Рабочие часы 10:00–22:00; у «Красного» сегодня выходной (как hoursToday),
// «ПК 5» работает до 20:00 (вне графика после). На завтра у «Красного»: ПК 1 10:00–11:00 – бронь, ПК 2 10:00–10:30 –
// чужое удержание, ПК 3 10:00–12:00 – блокировка. У Алины (+7 913 123-45-67) – бронь на завтра 14:00–14:30 в Томске.
// Только для e2e: /__test/booking-reset, /__test/fail-next (следующий вызов операции – ошибка или задержка), /__test/bookings.
const TZ_OFFSET: Record<string, number> = { 'Asia/Novosibirsk': 7, 'Asia/Tomsk': 7, 'Asia/Omsk': 6 };
const MIN = 60_000;
const HOLD_MINUTES = 15;
const WINDOW_MAX_DAYS = 30;
const MAX_HOLD_ITEMS = 20;
const RATE_KOP: Record<string, number> = { pc: 15_000, vr_seat: 20_000, room_whole: 60_000, ps_room: 25_000 }; // за шаг ресурса

const localDate = (t: number, tz: string) => new Date(t + (TZ_OFFSET[tz] ?? 0) * 60 * MIN).toISOString().slice(0, 10);
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 1440 * MIN).toISOString().slice(0, 10);
const at = (date: string, hhmm: string, tz: string) => Date.parse(`${date}T${hhmm}:00Z`) - (TZ_OFFSET[tz] ?? 0) * 60 * MIN;
const iso = (t: number) => new Date(t).toISOString();

type Branch = (typeof branches)[number];
type Resource = ReturnType<typeof seedResources>[number];
interface MHoldItem { id: string; resourceId: string; units: string[]; start: number; end: number; status: 'active' | 'removed' | 'converted' }
interface MHold { id: string; branchId: string; clientId: string | null; visitorId: string | null; status: 'active' | 'converted' | 'released'; expiresAt: number; items: MHoldItem[]; checkout?: unknown }
type MStatus = 'confirmed' | 'arrived' | 'completed' | 'no_show' | 'cancelled_by_client' | 'cancelled_by_club';
interface MBooking { id: string; number: number; checkoutId: string; branchId: string; clientId: string; resourceId: string; units: string[]; start: number; end: number; priceKop: number; status: MStatus; arrivedAt: number | null }
/** Бронь занимает время, пока она действует (отменённые и закрытые – нет). */
const occupies = (b: MBooking) => b.status === 'confirmed' || b.status === 'arrived';
interface Owner { clientId: string | null; visitorId: string | null }

const holds = new Map<string, MHold>();
let bookings: MBooking[] = [];
let bookingNo = 1000;
const replies = new Map<string, { status: number; body: unknown }>();
let failNext: { op: string; status: number; code: string; details?: Record<string, unknown>; delayMs?: number } | null = null;

class MockError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const resourcesOf = (branchId: string) => seedResources(branchId);
/** Подарочный ресурс gift_vr (K20 §8.2, gift-resource.ts): VR1+VR2 без PS4, self_bookable = false – в публичном списке ресурсов
 *  и в доступности его нет, тариф 0 ₽; удержание – только с грантом подарка (без него RESOURCE_UNAVAILABLE, hold.ts). */
const giftResource = (branchId: string): Resource => ({ ...resourcesOf(branchId).find((r) => r.type === 'room_whole')!, id: resourceId(branchId, 'gift'), type: 'gift_vr', name: 'Подарок: 2 VR', stepMinutes: 5 });
const findResource = (id: string): Resource | undefined => publicBranches().flatMap((b) => [...resourcesOf(b.id), giftResource(b.id)]).find((r) => r.id === id);
/** Вся комната VR и подарок = оба места (expandToUnits); остальные ресурсы – одна единица. */
const unitsOf = (r: Resource) => (r.type === 'room_whole' || r.type === 'gift_vr' ? [resourceId(r.branchId, 'vr1'), resourceId(r.branchId, 'vr2')] : [r.id]);
const branchOf = (id: string) => publicBranches().find((b) => b.id === id);

/** Интервалы работы ресурса в день по зоне филиала. */
function openOf(b: Branch, r: Resource | null, date: string): Array<[number, number]> {
  if (b.status !== 'active') return [];
  if (b.slug === 'krasny-prospekt' && date === localDate(Date.now(), b.timezone)) return [];
  const end = r && r.id === resourceId(b.id, 'pc5') ? '20:00' : '22:00';
  return [[at(date, '10:00', b.timezone), at(date, end, b.timezone)]];
}

/** Постоянная занятость на завтра у «Красного». */
function staticBusy(b: Branch, date: string): Array<{ unit: string; start: number; end: number; kind: 'booked' | 'held' | 'blocked' }> {
  if (b.slug !== 'krasny-prospekt' || date !== plusDays(localDate(Date.now(), b.timezone), 1)) return [];
  const t = (h: string) => at(date, h, b.timezone);
  return [
    { unit: resourceId(b.id, 'pc1'), start: t('10:00'), end: t('11:00'), kind: 'booked' },
    { unit: resourceId(b.id, 'pc2'), start: t('10:00'), end: t('10:30'), kind: 'held' },
    { unit: resourceId(b.id, 'pc3'), start: t('10:00'), end: t('12:00'), kind: 'blocked' },
  ];
}

const isLive = (h: MHold, now: number) => h.status === 'active' && h.expiresAt > now;
const ownedBy = (h: MHold, o: Owner) => (o.clientId !== null && h.clientId === o.clientId) || (o.visitorId !== null && h.clientId === null && h.visitorId === o.visitorId);
const overlaps = (s1: number, e1: number, s2: number, e2: number) => s1 < e2 && s2 < e1;

/** Записи ЛК (K9): у Алины – будущая в Томске (её же ловит CLIENT_OVERLAP), идущий сеанс (пришла, ещё не кончился),
 *  завершённая с посещением, неявка, закончившаяся без отметки, две отменённые; у Петра – свои, Алине не видны. */
function seedBookings() {
  bookings = [];
  const alina = clients.find((c) => c.phone === '+79131234567')!;
  const petr = clients.find((c) => c.phone === '+79135550000')!;
  const tomsk = branches.find((b) => b.slug === 'lenina')!;
  const krasny = branches.find((b) => b.slug === 'krasny-prospekt')!;
  const date = plusDays(localDate(Date.now(), tomsk.timezone), 1);
  const hour = Math.floor(Date.now() / (60 * MIN)) * 60 * MIN;
  const add = (clientId: string, b: Branch, code: string, start: number, end: number, status: MStatus, arrivedAt: number | null = null) => {
    const r = findResource(resourceId(b.id, code))!;
    bookings.push({ id: randomUUID(), number: ++bookingNo, checkoutId: randomUUID(), branchId: b.id, clientId, resourceId: r.id, units: unitsOf(r), start, end, priceKop: priceOf(r, start, end), status, arrivedAt });
  };
  add(alina.id, tomsk, 'pc1', at(date, '14:00', tomsk.timezone), at(date, '14:30', tomsk.timezone), 'confirmed');
  add(alina.id, krasny, 'ps5-2', hour - 60 * MIN, hour + 120 * MIN, 'arrived', hour - 55 * MIN);
  add(alina.id, krasny, 'vr1', hour - 72 * 60 * MIN, hour - 71 * 60 * MIN, 'completed', hour - 72 * 60 * MIN + 3 * MIN);
  add(alina.id, tomsk, 'pc2', hour - 120 * 60 * MIN, hour - 119 * 60 * MIN, 'no_show');
  add(alina.id, krasny, 'pc4', hour - 26 * 60 * MIN, hour - 25 * 60 * MIN, 'confirmed');
  add(alina.id, krasny, 'pc3', hour + 50 * 60 * MIN, hour + 51 * 60 * MIN, 'cancelled_by_club');
  add(alina.id, tomsk, 'ps5-1', hour - 30 * 60 * MIN, hour - 29 * 60 * MIN, 'cancelled_by_client');
  add(petr.id, tomsk, 'pc5', hour + 30 * 60 * MIN, hour + 31 * 60 * MIN, 'confirmed');
  add(petr.id, tomsk, 'vr2', hour - 50 * 60 * MIN, hour - 49 * 60 * MIN, 'completed', hour - 50 * 60 * MIN);
}
seedBookings();

function priceOf(r: Resource, start: number, end: number) {
  return Math.round(((end - start) / (r.stepMinutes * MIN)) * (RATE_KOP[r.type] ?? 0));
}

function holdDto(h: MHold, now: number) {
  const status = h.status === 'active' && h.expiresAt <= now ? 'expired' : h.status;
  const items = status === 'expired' || status === 'released' ? [] : h.items.filter((i) => i.status !== 'removed').sort((a, b) => a.start - b.start);
  const dto = items.map((i) => {
    const r = findResource(i.resourceId)!;
    return { id: i.id, resourceId: i.resourceId, resourceName: r.name, start: iso(i.start), end: iso(i.end), priceKop: priceOf(r, i.start, i.end) };
  });
  return { id: h.id, branchId: h.branchId, status, expiresAt: iso(h.expiresAt), serverNow: iso(now), items: dto, totalKop: dto.reduce((a, i) => a + i.priceKop, 0), owner: h.clientId ? 'client' : 'visitor' };
}

/** Пересечения клиента по сети (client_time): живые позиции его удержаний и брони. */
function clientOverlap(clientId: string, start: number, end: number, skipItem?: string) {
  const now = Date.now();
  const inHolds = [...holds.values()].some((h) => h.clientId === clientId && isLive(h, now) && h.items.some((i) => i.status === 'active' && i.id !== skipItem && overlaps(i.start, i.end, start, end)));
  return inHolds || bookings.some((b) => b.clientId === clientId && occupies(b) && overlaps(b.start, b.end, start, end));
}

/** Проверки позиции 01 §8.2 и занятость единиц (EXCLUDE в API) – те же коды. */
function checkItem(b: Branch, raw: unknown, owner: Owner, grant = false): MHoldItem {
  const now = Date.now();
  const it = (raw ?? {}) as { resourceId?: unknown; start?: unknown; end?: unknown };
  const start = typeof it.start === 'string' ? Date.parse(it.start) : NaN;
  const end = typeof it.end === 'string' ? Date.parse(it.end) : NaN;
  if (typeof it.resourceId !== 'string' || !Number.isFinite(start) || !Number.isFinite(end)) throw new MockError(400, 'VALIDATION_FAILED', 'Проверьте данные');
  const r = findResource(it.resourceId);
  if (!r || r.branchId !== b.id) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
  if (r.type === 'gift_vr' && !grant) throw new MockError(409, 'RESOURCE_UNAVAILABLE', 'Это место недоступно для записи', { resourceId: r.id });
  if (!(start < end)) throw new MockError(422, 'INVALID_DURATION', 'Конец раньше начала', { reason: 'empty' });
  const date = localDate(start, b.timezone);
  const today = localDate(now, b.timezone);
  if (start <= now || date < today || date >= plusDays(today, WINDOW_MAX_DAYS)) throw new MockError(422, 'OUTSIDE_BOOKING_WINDOW', `Запись доступна на ${WINDOW_MAX_DAYS} дней вперёд`, { maxDays: WINDOW_MAX_DAYS });
  const step = r.stepMinutes * MIN;
  if ((end - start) % step !== 0 || (start - at(date, '10:00', b.timezone)) % step !== 0) throw new MockError(422, 'INVALID_DURATION', `Выберите время кратно ${r.stepMinutes} минутам`);
  if (b.status !== 'active') throw new MockError(409, 'BRANCH_NOT_ACTIVE', 'Филиал сейчас не принимает записи');
  if (!openOf(b, r, date).some(([s, e]) => s <= start && end <= e)) throw new MockError(409, 'OUTSIDE_SCHEDULE', 'В это время филиал не работает');
  const units = unitsOf(r);
  const fixed = staticBusy(b, date).filter((x) => units.includes(x.unit) && overlaps(x.start, x.end, start, end));
  if (fixed.some((x) => x.kind === 'blocked')) throw new MockError(409, 'RESOURCE_BLOCKED', 'Ресурс заблокирован');
  if (fixed.some((x) => x.kind === 'booked') || bookings.some((x) => occupies(x) && x.units.some((u) => units.includes(u)) && overlaps(x.start, x.end, start, end))) throw new MockError(409, 'SLOT_TAKEN', 'Это время уже занято');
  const held = [...holds.values()].some((h) => isLive(h, now) && h.items.some((i) => i.status === 'active' && i.units.some((u) => units.includes(u)) && overlaps(i.start, i.end, start, end)));
  if (held || fixed.some((x) => x.kind === 'held')) throw new MockError(409, 'SLOT_HELD', 'Это время сейчас удерживается');
  if (owner.clientId && clientOverlap(owner.clientId, start, end)) throw new MockError(409, 'CLIENT_OVERLAP', 'У вас уже есть запись на это время');
  return { id: randomUUID(), resourceId: r.id, units, start, end, status: 'active' };
}

function ownActiveHold(branchId: string, o: Owner): MHold | undefined {
  const now = Date.now();
  return [...holds.values()].find((h) => h.branchId === branchId && isLive(h, now) && (o.clientId ? h.clientId === o.clientId : h.clientId === null && h.visitorId === o.visitorId));
}

const visitorOf = (cookie: string | undefined) => {
  const v = readCookie(cookie, 'yu_visitor');
  return v && UUID.test(v) ? v : null;
};
const clientOf = (cookie: string | undefined) => {
  const token = readCookie(cookie, 'yu_client');
  return (token && sessions.get(token)) || null;
};

/** attach (K5 №11): к клиенту; пересечение по сети → CLIENT_OVERLAP. */
function attach(h: MHold, clientId: string): void {
  const now = Date.now();
  if (h.clientId === clientId) return;
  if (!isLive(h, now)) throw new MockError(410, 'HOLD_EXPIRED', 'Время на оформление истекло, слоты освобождены');
  const other = ownActiveHold(h.branchId, { clientId, visitorId: null });
  if (other) throw new MockError(409, 'HOLD_ALREADY_ACTIVE', 'Уже есть активное удержание в этом филиале', { holdId: other.id });
  const active = h.items.filter((i) => i.status === 'active');
  if (active.some((i) => clientOverlap(clientId, i.start, i.end)) || active.some((i, k) => active.some((j, m) => m < k && overlaps(i.start, i.end, j.start, j.end)))) {
    throw new MockError(409, 'CLIENT_OVERLAP', 'У вас уже есть запись на это время');
  }
  h.clientId = clientId;
}

/** Хук входа: удержания посетителя переходят к клиенту; конфликтующее остаётся посетителю (вход не падает). */
function attachVisitorHolds(clientId: string, visitorId: string | null) {
  if (!visitorId) return;
  for (const h of holds.values()) {
    if (h.visitorId !== visitorId || h.clientId !== null || !isLive(h, Date.now())) continue;
    try {
      attach(h, clientId);
    } catch (e) {
      if (!(e instanceof MockError)) throw e;
    }
  }
}

function confirm(h: MHold, clientId: string) {
  const now = Date.now();
  if (h.status === 'converted') return h.checkout;
  if (!isLive(h, now)) throw new MockError(410, 'HOLD_EXPIRED', 'Время на оформление истекло, слоты освобождены');
  const items = h.items.filter((i) => i.status === 'active').sort((a, b) => a.start - b.start);
  if (items.length === 0) throw new MockError(410, 'HOLD_EXPIRED', 'Время на оформление истекло, слоты освобождены');
  const client = clients.find((c) => c.id === clientId);
  if (client?.status === 'restricted') throw new MockError(403, 'CLIENT_RESTRICTED', 'Запись для клиента ограничена');
  const b = branchOf(h.branchId)!;
  const checkoutId = randomUUID();
  const groups: MHoldItem[][] = [];
  for (const i of items) {
    const g = groups.find((x) => x[0]!.resourceId === i.resourceId && x.at(-1)!.end === i.start);
    if (g) g.push(i);
    else groups.push([i]);
  }
  const made = groups.map((g) => {
    const r = findResource(g[0]!.resourceId)!;
    const bk: MBooking = { id: randomUUID(), number: ++bookingNo, checkoutId, branchId: b.id, clientId, resourceId: r.id, units: g[0]!.units, start: g[0]!.start, end: g.at(-1)!.end, priceKop: priceOf(r, g[0]!.start, g.at(-1)!.end), status: 'confirmed', arrivedAt: null };
    bookings.push(bk);
    return bk;
  });
  for (const i of items) i.status = 'converted';
  h.status = 'converted';
  h.checkout = K.ConfirmResultDto.parse({ checkoutId, bookings: made.map((bk) => bookingDto(bk, now)) });
  return h.checkout;
}

/** BookingDto (K5, confirm.ts bookingDtos): canCancel – действующая, начало в будущем (отмена клиентом включена). */
function bookingDto(bk: MBooking, now: number) {
  const b = branches.find((x) => x.id === bk.branchId)!;
  return K.BookingDto.parse({
    id: bk.id, number: bk.number, branchId: b.id, branchName: b.name, branchAddress: b.address, timezone: b.timezone,
    resourceId: bk.resourceId, resourceName: findResource(bk.resourceId)!.name, start: iso(bk.start), end: iso(bk.end),
    durationMinutes: (bk.end - bk.start) / MIN, priceKop: bk.priceKop, paymentNote: 'pay_at_club', status: bk.status,
    canCancel: bk.status === 'confirmed' && bk.start > now,
  });
}

/** Вкладки ЛК – как TABS в routes.public.ts: идущий сеанс – в будущих; закончившаяся без отметки – в прошлых. */
const TABS: Record<'upcoming' | 'past' | 'cancelled', { match: (b: MBooking, now: number) => boolean; asc: boolean }> = {
  upcoming: { match: (b, now) => occupies(b) && b.end > now, asc: true },
  past: { match: (b, now) => b.status === 'completed' || b.status === 'no_show' || (occupies(b) && b.end <= now), asc: false },
  cancelled: { match: (b) => b.status === 'cancelled_by_client' || b.status === 'cancelled_by_club', asc: false },
};
const PAGE = 20;
const cursorOf = (at: number, id: string) => Buffer.from(JSON.stringify([iso(at), id])).toString('base64url');
function afterCursor(cursor: string | undefined): [number, string] | null | 'bad' {
  if (cursor === undefined) return null;
  try {
    const [a, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    const t = Date.parse(a);
    return Number.isFinite(t) && UUID.test(id) ? [t, id] : 'bad';
  } catch {
    return 'bad';
  }
}
function pageOf<T extends { id: string }>(rows: T[], key: (x: T) => number, asc: boolean, cursor: [number, string] | null) {
  const cmp = (a: T, b: T) => (key(a) - key(b) || a.id.localeCompare(b.id)) * (asc ? 1 : -1);
  const sorted = [...rows].sort(cmp);
  const from = cursor ? sorted.filter((x) => (key(x) - cursor[0] || x.id.localeCompare(cursor[1])) * (asc ? 1 : -1) > 0) : sorted;
  const items = from.slice(0, PAGE);
  const last = items.at(-1);
  return { items, nextCursor: from.length > PAGE && last ? cursorOf(key(last), last.id) : null };
}

/** Окна подарка на день (giftSlots, routes.gifts.ts): начало на сетке 15 мин от открытия, длительность minutes, оба шлема свободны –
 *  занятость та же, что у удержаний и броней (один занятый шлем – окна нет). Проверки дня (будни, праздник, срок) – в mock-events.ts. */
function giftWindows(branchId: string, date: string, minutes: number): { closedReason: string | null; slots: Array<{ start: string; end: string }> } {
  const b = branchOf(branchId);
  if (!b) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
  const now = Date.now();
  const today = localDate(now, b.timezone);
  if (date < today || date >= plusDays(today, WINDOW_MAX_DAYS)) return { closedReason: 'OUTSIDE_BOOKING_WINDOW', slots: [] };
  const units = unitsOf(giftResource(b.id));
  const fixed = staticBusy(b, date);
  const live = [...holds.values()].filter((h) => isLive(h, now));
  const busy = (s: number, e: number) =>
    fixed.some((x) => units.includes(x.unit) && overlaps(x.start, x.end, s, e))
    || bookings.some((x) => occupies(x) && x.units.some((u) => units.includes(u)) && overlaps(x.start, x.end, s, e))
    || live.some((h) => h.items.some((i) => i.status === 'active' && i.units.some((u) => units.includes(u)) && overlaps(i.start, i.end, s, e)));
  const slots = [];
  for (const [os, oe] of openOf(b, null, date)) {
    for (let s = os; s + minutes * MIN <= oe; s += 15 * MIN) {
      if (s > now && !busy(s, s + minutes * MIN)) slots.push({ start: iso(s), end: iso(s + minutes * MIN) });
    }
  }
  return { closedReason: null, slots };
}

/** Удержание по подарку (holdGift → createHold с грантом): обычное K5 – тот же таймер и HOLD_ALREADY_ACTIVE, позиция – подарочный ресурс, цена 0. */
function giftHold(clientId: string, branchId: string, start: string, minutes: number) {
  const b = branchOf(branchId);
  if (!b) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
  if (b.status !== 'active') throw new MockError(409, 'BRANCH_NOT_ACTIVE', 'Филиал сейчас не принимает записи');
  const o: Owner = { clientId, visitorId: null };
  const existing = ownActiveHold(b.id, o);
  if (existing) throw new MockError(409, 'HOLD_ALREADY_ACTIVE', 'Уже есть активное удержание – добавьте слот в него', { holdId: existing.id });
  const t = Date.parse(start);
  const item = checkItem(b, { resourceId: giftResource(b.id).id, start, end: iso(t + minutes * MIN) }, o, true);
  const h: MHold = { id: randomUUID(), branchId: b.id, clientId, visitorId: null, status: 'active', expiresAt: Date.now() + HOLD_MINUTES * MIN, items: [item] };
  holds.set(h.id, h);
  return holdDto(h, Date.now());
}
function registerBooking(app: FastifyInstance, P: string) {
  const send = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof MockError)) throw e;
    return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details, requestId: randomUUID() } });
  };
  /** Подмена из e2e: ошибка или задержка на следующий вызов операции. */
  async function injected(op: string, reply: FastifyReply): Promise<boolean> {
    if (!failNext || failNext.op !== op) return false;
    const f = failNext;
    failNext = null;
    if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
    if (!f.status) return false;
    await reply.code(f.status).send({ error: { code: f.code, message: f.code, details: f.details ?? {}, requestId: randomUUID() } });
    return true;
  }

  app.post('/__test/booking-reset', async () => {
    holds.clear();
    replies.clear();
    failNext = null;
    seedBookings();
    return { ok: true };
  });
  app.post('/__test/fail-next', async (req) => {
    failNext = req.body as typeof failNext;
    return { ok: true };
  });
  app.get('/__test/bookings', async () => ({ items: bookings.map((b) => ({ id: b.id, checkoutId: b.checkoutId, resourceId: b.resourceId, start: iso(b.start) })) }));

  app.get(`${P}/branches/:id/availability`, async (req, reply) => {
    let visitorId = visitorOf(req.headers.cookie);
    if (!visitorId) {
      visitorId = randomUUID();
      reply.header('set-cookie', `yu_visitor=${visitorId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
    }
    if (await injected('availability', reply)) return reply;
    const b = branchOf((req.params as { id: string }).id);
    if (!b) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    const { date } = req.query as { date?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Проверьте данные', details: { field: 'date' }, requestId: randomUUID() } });
    const now = Date.now();
    const today = localDate(now, b.timezone);
    const viewer: Owner = { clientId: clientOf(req.headers.cookie), visitorId };
    const base = { branchId: b.id, date, timezone: b.timezone, generatedAt: iso(now) };
    if (date < today || date >= plusDays(today, WINDOW_MAX_DAYS)) return { ...base, dayState: 'outside_window', openIntervals: [], resources: [] };
    const branchOpen = openOf(b, null, date);
    const rs = resourcesOf(b.id);
    const openDto = branchOpen.map(([s, e]) => ({ start: iso(s), end: iso(e) }));
    if (branchOpen.length === 0) return { ...base, dayState: 'closed', openIntervals: openDto, resources: rs.map((r) => ({ resourceId: r.id, slots: [] })) };
    const fixed = staticBusy(b, date);
    const live = [...holds.values()].filter((h) => isLive(h, now));
    return {
      ...base, dayState: 'open', openIntervals: openDto,
      resources: rs.map((r) => {
        const units = unitsOf(r);
        const own = openOf(b, r, date);
        const slots = [];
        for (const [os, oe] of branchOpen) {
          for (let s = os; s + r.stepMinutes * MIN <= oe; s += r.stepMinutes * MIN) {
            const e = s + r.stepMinutes * MIN;
            const hit = (u: string[]) => u.some((x) => units.includes(x));
            let state: string;
            if (s <= now || !own.some(([a, z]) => a <= s && e <= z)) state = 'closed';
            else if (fixed.some((x) => x.kind === 'blocked' && hit([x.unit]) && overlaps(x.start, x.end, s, e))) state = 'blocked';
            else {
              const kinds: string[] = [];
              for (const x of fixed) if (x.kind !== 'blocked' && hit([x.unit]) && overlaps(x.start, x.end, s, e)) kinds.push(x.kind);
              for (const x of bookings) if (occupies(x) && hit(x.units) && overlaps(x.start, x.end, s, e)) kinds.push('booked');
              for (const h of live) for (const i of h.items) if (i.status === 'active' && hit(i.units) && overlaps(i.start, i.end, s, e)) kinds.push(ownedBy(h, viewer) ? 'mine' : 'held');
              state = kinds.length === 0 ? 'free' : kinds.every((k) => k === 'mine') ? 'mine' : kinds.includes('booked') ? 'booked' : 'held';
            }
            slots.push({ start: iso(s), end: iso(e), state });
          }
        }
        return { resourceId: r.id, slots };
      }),
    };
  });

  /** Команда: владелец → ключ → повтор того же ответа (ADR 0004) → выполнение. */
  function command(op: string, okStatus: number, run: (o: Owner, params: Record<string, string>, body: unknown) => unknown) {
    return async (req: { headers: Record<string, string | string[] | undefined>; params: unknown; body: unknown }, reply: FastifyReply) => {
      const cookie = req.headers.cookie as string | undefined;
      const o: Owner = { clientId: clientOf(cookie), visitorId: visitorOf(cookie) };
      if (!o.clientId && !o.visitorId) return fail(reply, 400, 'VISITOR_REQUIRED', 'Нужна кука посетителя');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !key.trim()) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      const scope = `${o.clientId ? `c:${o.clientId}` : `v:${o.visitorId}`}|${op}|${key}`;
      const prev = replies.get(scope);
      if (prev) return reply.header('idempotent-replay', 'true').code(prev.status).send(prev.body);
      if (await injected(op, reply)) return reply;
      try {
        const body = run(o, req.params as Record<string, string>, req.body);
        replies.set(scope, { status: okStatus, body });
        return reply.code(okStatus).send(body);
      } catch (e) {
        return send(reply, e);
      }
    };
  }
  const lockHold = (id: string | undefined, o: Owner) => {
    const h = id ? holds.get(id) : undefined;
    if (!h || !ownedBy(h, o)) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
    return h;
  };
  const expired = () => new MockError(410, 'HOLD_EXPIRED', 'Время на оформление истекло, слоты освобождены');

  app.post(`${P}/holds`, command('create', 201, (o, _p, body) => {
    const input = (body ?? {}) as { branchId?: unknown; items?: unknown };
    const b = typeof input.branchId === 'string' ? branchOf(input.branchId) : undefined;
    if (!b) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
    if (b.status !== 'active') throw new MockError(409, 'BRANCH_NOT_ACTIVE', 'Филиал сейчас не принимает записи');
    if (!Array.isArray(input.items) || input.items.length === 0) throw new MockError(400, 'VALIDATION_FAILED', 'Нет позиций', { field: 'items' });
    if (input.items.length > MAX_HOLD_ITEMS) throw new MockError(422, 'HOLD_LIMIT_REACHED', 'Слишком много слотов в одной записи', { max: MAX_HOLD_ITEMS });
    const existing = ownActiveHold(b.id, o);
    if (existing) throw new MockError(409, 'HOLD_ALREADY_ACTIVE', 'Уже есть активное удержание – добавьте слот в него', { holdId: existing.id });
    const items = input.items.map((x) => checkItem(b, x, o));
    const h: MHold = { id: randomUUID(), branchId: b.id, clientId: o.clientId, visitorId: o.visitorId, status: 'active', expiresAt: Date.now() + HOLD_MINUTES * MIN, items };
    holds.set(h.id, h);
    return holdDto(h, Date.now());
  }));

  app.get(`${P}/holds/:holdId`, async (req, reply) => {
    try {
      const o: Owner = { clientId: clientOf(req.headers.cookie), visitorId: visitorOf(req.headers.cookie) };
      return holdDto(lockHold((req.params as { holdId: string }).holdId, o), Date.now());
    } catch (e) {
      return send(reply, e);
    }
  });

  app.post(`${P}/holds/:holdId/items`, command('add', 200, (o, p, body) => {
    const h = lockHold(p.holdId, o);
    if (!isLive(h, Date.now())) throw expired();
    if (h.items.filter((i) => i.status === 'active').length + 1 > MAX_HOLD_ITEMS) throw new MockError(422, 'HOLD_LIMIT_REACHED', 'Слишком много слотов в одной записи', { max: MAX_HOLD_ITEMS });
    h.items.push(checkItem(branchOf(h.branchId)!, body, o));
    h.expiresAt = Date.now() + HOLD_MINUTES * MIN; // добавление перезапускает общий таймер (01 §7)
    return holdDto(h, Date.now());
  }));

  app.delete(`${P}/holds/:holdId/items/:itemId`, command('remove', 200, (o, p) => {
    const h = lockHold(p.holdId, o);
    if (!isLive(h, Date.now())) throw expired();
    const active = h.items.filter((i) => i.status === 'active');
    const item = active.find((i) => i.id === p.itemId);
    if (!item) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
    item.status = 'removed';
    if (active.length === 1) h.status = 'released';
    return holdDto(h, Date.now());
  }));

  app.post(`${P}/holds/:holdId/release`, command('release', 200, (o, p) => {
    const h = lockHold(p.holdId, o);
    if (h.status === 'active') h.status = 'released';
    return holdDto(h, Date.now());
  }));

  app.post(`${P}/holds/:holdId/attach`, command('attach', 200, (o, p) => {
    if (!o.clientId) throw new MockError(401, 'AUTH_REQUIRED', 'Войдите, чтобы завершить запись');
    const h = lockHold(p.holdId, o);
    attach(h, o.clientId);
    return holdDto(h, Date.now());
  }));

  app.post(`${P}/bookings/:bookingId/cancel`, command('cancel', 200, (o, p, body) => {
    if (!o.clientId) throw new MockError(401, 'AUTH_REQUIRED', 'Войдите, чтобы завершить запись');
    if (!K.CancelBody.safeParse(body ?? {}).success) throw new MockError(400, 'VALIDATION_FAILED', 'Проверьте данные');
    const bk = bookings.find((x) => x.id === p.bookingId);
    if (!bk || bk.clientId !== o.clientId) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
    const now = Date.now();
    if (bk.status !== 'confirmed' || bk.start <= now) throw new MockError(409, 'BOOKING_NOT_CANCELLABLE', 'Эту запись уже нельзя отменить онлайн');
    bk.status = 'cancelled_by_client';
    return bookingDto(bk, now);
  }));

  const me = (req: { headers: { cookie?: string | undefined } }) => {
    const id = clientOf(req.headers.cookie);
    if (!id) throw new MockError(401, 'AUTH_REQUIRED', 'Войдите, чтобы завершить запись');
    return id;
  };
  app.get(`${P}/me/bookings`, async (req, reply) => {
    try {
      const clientId = me(req);
      if (await injected('my-bookings', reply)) return reply;
      const q = K.MyBookingsQuery.safeParse(req.query);
      const cursor = q.success ? afterCursor(q.data.cursor) : 'bad';
      if (!q.success || cursor === 'bad') throw new MockError(400, 'VALIDATION_FAILED', 'Проверьте данные');
      const now = Date.now();
      const t = TABS[q.data.tab];
      const pg = pageOf(bookings.filter((b) => b.clientId === clientId && t.match(b, now)), (b) => b.start, t.asc, cursor);
      return K.MyBookingsPage.parse({
        nextCursor: pg.nextCursor,
        items: pg.items.map((b) => {
          const r = findResource(b.resourceId)!;
          const city = cities.find((c) => c.id === branches.find((x) => x.id === b.branchId)!.cityId)!;
          return { ...bookingDto(b, now), cityName: city.name, roomName: r.roomName, visit: b.arrivedAt ? { arrivedAt: iso(b.arrivedAt) } : null };
        }),
      });
    } catch (e) {
      return send(reply, e);
    }
  });
  app.get(`${P}/me/visits`, async (req, reply) => {
    try {
      const clientId = me(req);
      const q = K.MyVisitsQuery.safeParse(req.query);
      const cursor = q.success ? afterCursor(q.data.cursor) : 'bad';
      if (!q.success || cursor === 'bad') throw new MockError(400, 'VALIDATION_FAILED', 'Проверьте данные');
      const pg = pageOf(bookings.filter((b) => b.clientId === clientId && b.arrivedAt !== null), (b) => b.arrivedAt!, false, cursor);
      return K.MyVisitsPage.parse({
        nextCursor: pg.nextCursor,
        items: pg.items.map((b) => ({
          bookingId: b.id, number: b.number, branchName: branches.find((x) => x.id === b.branchId)!.name, resourceName: findResource(b.resourceId)!.name,
          plannedStart: iso(b.start), plannedEnd: iso(b.end), arrivedAt: iso(b.arrivedAt!), status: 'visited',
        })),
      });
    } catch (e) {
      return send(reply, e);
    }
  });

  app.post(`${P}/holds/:holdId/confirm`, command('confirm', 201, (o, p) => {
    if (!o.clientId) throw new MockError(401, 'AUTH_REQUIRED', 'Войдите, чтобы завершить запись');
    const h = holds.get(p.holdId ?? '');
    if (!h || h.clientId !== o.clientId) throw new MockError(404, 'NOT_FOUND', 'Не найдено');
    return confirm(h, o.clientId);
  }));
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? 4020);
  await buildMock().listen({ host: '127.0.0.1', port });
  console.log(`site mock-api: http://127.0.0.1:${port}`);
}
