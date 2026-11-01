// Мок публичного API записи для сайта – пока нет S1-08 (apps/api/src/modules/booking/routes.public.ts).
// Повторяет K5 №1–5 (города, филиалы, ресурсы, доступность) и тело ошибки ADR 0002; статусы – K13.
// Филиалы 'preparing'/'archived' лежат в данных, но наружу не отдаются (K5) – так e2e проверяет 404.
// Запуск: MOCK_PORT=4020 node tests/mock-api.ts; сайт: API_URL=http://127.0.0.1:4020.
import Fastify, { type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

type Status = 'preparing' | 'active' | 'temporarily_closed' | 'archived';
type Zone = 'pc' | 'vr' | 'ps';

const cities = [
  { id: 'c-nsk', slug: 'novosibirsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' },
  { id: 'c-tsk', slug: 'tomsk', name: 'Томск', timezone: 'Asia/Tomsk' },
  // Только готовящийся филиал – города в публичном списке нет.
  { id: 'c-omsk', slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' },
];

const branches: Array<{ id: string; cityId: string; slug: string; name: string; address: string; timezone: string; status: Status; phone: string | null }> = [
  { id: 'b-nsk-krasny', cityId: 'c-nsk', slug: 'krasny-prospekt', name: 'Ю-Клуб на Красном', address: 'Красный проспект, 25', timezone: 'Asia/Novosibirsk', status: 'active', phone: null },
  { id: 'b-nsk-akadem', cityId: 'c-nsk', slug: 'akademgorodok', name: 'Ю-Клуб Академгородок', address: 'Морской проспект, 2', timezone: 'Asia/Novosibirsk', status: 'temporarily_closed', phone: null },
  { id: 'b-nsk-new', cityId: 'c-nsk', slug: 'gorskiy', name: 'Ю-Клуб Горский', address: 'Горский микрорайон, 8', timezone: 'Asia/Novosibirsk', status: 'preparing', phone: null },
  { id: 'b-tsk-lenina', cityId: 'c-tsk', slug: 'lenina', name: 'Ю-Клуб на Ленина', address: 'проспект Ленина, 80', timezone: 'Asia/Tomsk', status: 'active', phone: null },
  { id: 'b-omsk-1', cityId: 'c-omsk', slug: 'mira', name: 'Ю-Клуб на Мира', address: 'проспект Мира, 5', timezone: 'Asia/Omsk', status: 'preparing', phone: null },
];

// Пилот по макету (карта сайта п.4): 5 ПК, комната VR+PS4, комнаты PS5.
function seedResources(branchId: string) {
  const r = (id: string, zone: Zone, type: string, name: string, roomId: string | null, roomName: string | null, stepMinutes: number) =>
    ({ id: `${branchId}-${id}`, branchId, roomId, roomName, type, zone, name, stepMinutes, selfBookable: true as const });
  return [
    ...[1, 2, 3, 4, 5].map((n) => r(`pc${n}`, 'pc', 'pc', `ПК ${n}`, `${branchId}-pc-zone`, 'Зал ПК', 30)),
    r('vr1', 'vr', 'vr_seat', 'VR 1', `${branchId}-vr`, 'Комната VR+PS4', 30),
    r('vr2', 'vr', 'vr_seat', 'VR 2', `${branchId}-vr`, 'Комната VR+PS4', 30),
    r('vr-room', 'vr', 'room_whole', 'Вся комната', `${branchId}-vr`, 'Комната VR+PS4', 60),
    ...[1, 2, 3].map((n) => r(`ps5-${n}`, 'ps', 'ps_room', `PS5 ${n}`, `${branchId}-ps5-${n}`, `Комната PS5 ${n}`, 60)),
  ];
}

const isPublic = (s: Status) => s === 'active' || s === 'temporarily_closed';
const publicBranches = () => branches.filter((b) => isPublic(b.status));

function toDto(b: (typeof branches)[number]) {
  const { id, cityId, slug, name, address, timezone, status, phone } = b;
  return { id, cityId, slug, name, address, timezone, status, phone, publicContacts: {}, bookingWindow: { defaultDays: 7, maxDays: 30 }, holdMinutes: 10 };
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: randomUUID() } });
}

/** Локальное «HH:MM» даты филиала → ISO UTC. Смещение зоны берём у Intl на эту дату (без DST в Сибири, но честно). */
function localToUtc(date: string, time: string, timezone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(guess);
  const off = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.find((p) => p.type === 'timeZoneName')?.value ?? '');
  const minutes = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : 0;
  return new Date(guess.getTime() - minutes * 60_000).toISOString();
}

export function buildMock() {
  const app = Fastify({ logger: false });
  const P = '/api/public/v1';

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
    return b ? toDto(b) : fail(reply, 404, 'NOT_FOUND', 'Не найдено');
  });

  app.get(`${P}/branches/:id/resources`, async (req, reply) => {
    const b = publicBranches().find((x) => x.id === (req.params as { id: string }).id);
    if (!b) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    const { zone } = req.query as { zone?: string };
    return { items: seedResources(b.id).filter((r) => !zone || r.zone === zone) };
  });

  app.get(`${P}/branches/:id/availability`, async (req, reply) => {
    const b = publicBranches().find((x) => x.id === (req.params as { id: string }).id);
    if (!b) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    const { date } = req.query as { date?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(reply, 400, 'VALIDATION_FAILED', 'Проверьте данные');
    const open = b.status === 'active';
    return {
      branchId: b.id, date, timezone: b.timezone,
      dayState: open ? 'open' : 'closed',
      openIntervals: open ? [{ start: localToUtc(date, '10:00', b.timezone), end: localToUtc(date, '22:00', b.timezone) }] : [],
      // Слоты – шаг S1-19; каркасу сайта нужны только часы дня.
      resources: [],
      generatedAt: new Date().toISOString(),
    };
  });

  return app;
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? 4020);
  await buildMock().listen({ host: '127.0.0.1', port });
  console.log(`site mock-api: http://127.0.0.1:${port}`);
}
