// Мок ресурсов филиала (K5 №4, S1-21) – по apps/api/src/modules/network/routes.public.ts: GET /branches/{id}/resources
// отдаёт только ресурсы для самозаписи в активных опубликованных комнатах (listBookableResources), ответ – схема
// ResourceDto из packages/contracts. Комната в архиве («Космос») лежит в данных, но наружу не отдаётся – так e2e
// проверяет 404 её страницы. Поля вместимости в ResourceDto нет – сайт число не показывает (12 §7.1).
// Только для e2e: POST /__test/resources-empty { branchId | null } – филиал без опубликованных комнат (пустое состояние).
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as K from '../../../packages/contracts/src/booking.ts';

type Zone = 'pc' | 'vr' | 'ps';

// Пилот по макету (карта сайта п.4): 5 ПК, комната VR+PS4, комнаты PS5. Шаг: VR-место 15 мин, ПК, комната VR и PS5 – 30.
// id – UUID, как в API (z.uuid() в теле удержания): ресурс `0b0e{4 цифры филиала}-…-{код}`, комната `0b0f…`.
const CODE: Record<string, string> = { pc1: '01', pc2: '02', pc3: '03', pc4: '04', pc5: '05', vr1: '11', vr2: '12', 'vr-room': '13', 'ps5-1': '21', 'ps5-2': '22', 'ps5-3': '23', 'pc-zone': '31', vr: '32', kosmos: '41' };
export const resourceId = (branchId: string, code: string) => `0b0e${branchId.slice(-4)}-0000-4000-8000-0000000000${CODE[code] ?? '99'}`;
const roomId = (branchId: string, code: string) => `0b0f${branchId.slice(-4)}-0000-4000-8000-0000000000${CODE[code] ?? '99'}`;

/** Все ресурсы филиала, включая комнату в архиве (published = false). */
function allResources(branchId: string) {
  const r = (id: string, zone: Zone, type: string, name: string, room: string, roomName: string, stepMinutes: number, published = true) =>
    ({ published, dto: { id: resourceId(branchId, id), branchId, roomId: roomId(branchId, room), roomName, type, zone, name, stepMinutes, selfBookable: true as const } });
  return [
    ...[1, 2, 3, 4, 5].map((n) => r(`pc${n}`, 'pc', 'pc', `ПК ${n}`, 'pc-zone', 'Зал ПК', 30)),
    r('vr1', 'vr', 'vr_seat', 'VR 1', 'vr', 'Комната VR+PS4', 15),
    r('vr2', 'vr', 'vr_seat', 'VR 2', 'vr', 'Комната VR+PS4', 15),
    r('vr-room', 'vr', 'room_whole', 'Вся комната', 'vr', 'Комната VR+PS4', 30),
    ...[1, 2, 3].map((n) => r(`ps5-${n}`, 'ps', 'ps_room', `PS5 ${n}`, `ps5-${n}`, `Комната PS5 ${n}`, 30)),
    r('kosmos', 'ps', 'ps_room', 'Космос', 'kosmos', 'Космос', 30, false),
  ];
}

/** Публичный вид – как listBookableResources: только опубликованные активные комнаты. */
export const seedResources = (branchId: string) => allResources(branchId).filter((x) => x.published).map((x) => x.dto);

let emptyBranch: string | null = null;

export function registerResources(app: FastifyInstance, P: string, isPublicBranch: (id: string) => boolean, fail: (reply: FastifyReply, status: number, code: string, message: string) => unknown) {
  app.post('/__test/resources-empty', async (req) => {
    emptyBranch = ((req.body ?? {}) as { branchId?: string | null }).branchId ?? null;
    return { ok: true };
  });
  app.get(`${P}/branches/:id/resources`, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!isPublicBranch(id)) return fail(reply, 404, 'NOT_FOUND', 'Не найдено');
    const { zone } = req.query as { zone?: string };
    const items = id === emptyBranch ? [] : seedResources(id).filter((r) => !zone || r.zone === zone);
    return { items: K.ResourceDto.array().parse(items) };
  });
}
