// S1-27: модель VR+PS4 на живом стенде – 6 сценариев tz/18 §5.3. VR-комната засева (db/seed/resources.ts):
// места VR1, VR2, единица PS4 без своего ресурса и «VR-комната целиком» из трёх единиц.
// Филиал «на Красном» (Новосибирск), каждый сценарий – свой день (+3…+9, мимо +7 – исключение графика засева,
// +2 – дни гонки S1-26) и своё время; два разных клиента (у одного клиента пересечение запрещено по сети – иначе
// отказ CLIENT_OVERLAP скрыл бы проверку ресурсов). После каждого теста созданные брони отменяются.
import { expect, test } from '@playwright/test';
import {
  at, branchBySlug, dayIn, newClient, resourcesOf, siteContext, sql,
  type ApiErr, type BookingDto, type SiteClient, type Slot, type StandBranch, type StandResource,
} from './stand.ts';

let A: SiteClient;
let B: SiteClient;
let branch: StandBranch;
let vr1: StandResource;
let vr2: StandResource;
let whole: StandResource;
let all: StandResource[];
const made: Array<{ who: SiteClient; id: string }> = [];

test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  const api = await siteContext();
  branch = await branchBySlug(api, 'novosibirsk', 'krasny');
  all = await resourcesOf(api, branch.id);
  await api.dispose();
  const room = all.filter((r) => r.roomSlug === 'vr-ps4-room');
  vr1 = room.find((r) => r.name === 'VR1')!;
  vr2 = room.find((r) => r.name === 'VR2')!;
  whole = room.find((r) => r.type === 'room_whole')!;
  expect([vr1, vr2, whole].every(Boolean), 'VR1, VR2 и «вся комната» в засеве').toBe(true);
  A = await newClient();
  B = await newClient();
});

test.afterEach(async () => {
  for (const c of [A, B]) await c?.cleanup(made.filter((m) => m.who === c).map((m) => m.id));
  made.length = 0;
});

test.afterAll(async () => {
  await A?.dispose();
  await B?.dispose();
});

const tz = () => branch.timezone;
const slot = (r: StandResource, day: number, from: string, to: string) => {
  const d = dayIn(tz(), day);
  return { resourceId: r.id, start: at(d, from, tz()), end: at(d, to, tz()) };
};
async function book(who: SiteClient, items: ReturnType<typeof slot>[]): Promise<BookingDto[]> {
  const list = await who.book(branch.id, items);
  for (const b of list) made.push({ who, id: b.id });
  expect(list.every((b) => b.status === 'confirmed')).toBe(true);
  return list;
}
/** Состояния слотов ресурса на отрезке [from, to) по доступности сайта (то, что видит посетитель). */
async function states(r: StandResource, day: number, from: string, to: string): Promise<Slot['state'][]> {
  const d = dayIn(tz(), day);
  const a = await A.availability(branch.id, d);
  const s = Date.parse(at(d, from, tz()));
  const e = Date.parse(at(d, to, tz()));
  const slots = a.resources.find((x) => x.resourceId === r.id)?.slots ?? [];
  const inside = slots.filter((x) => Date.parse(x.start) < e && Date.parse(x.end) > s);
  expect(inside.length, `слоты ${r.name} ${from}–${to}`).toBeGreaterThan(0);
  return [...new Set(inside.map((x) => x.state))];
}
/** Отказ удержания по занятости: 409 и это не пересечение у клиента (ресурс, а не клиент). */
async function refused(p: Promise<unknown>): Promise<ApiErr> {
  const e = (await p.then(() => null, (x: unknown) => x)) as ApiErr | null;
  expect(e, 'удержание должно быть отклонено').not.toBeNull();
  expect(e!.status).toBe(409);
  expect(e!.code).not.toBe('CLIENT_OVERLAP');
  test.info().annotations.push({ type: 'отказ', description: `${e!.status} ${e!.code}` });
  return e!;
}
const unitsOf = (bookingId: string) =>
  sql(`SELECT u.code FROM app.occupancy o JOIN app.occupancy_units u ON u.id = o.unit_id
       WHERE o.source_type = 'booking' AND o.active AND o.source_id = '${bookingId}' ORDER BY u.code`);

test('1. два независимых VR – разные клиенты в одно время', async () => {
  const [a] = await book(A, [slot(vr1, 3, '12:00', '12:30')]);
  const [b] = await book(B, [slot(vr2, 3, '12:00', '12:30')]);
  expect(a!.resourceName).toBe('VR1');
  expect(b!.resourceName).toBe('VR2');
  expect(await states(vr1, 3, '12:00', '12:30')).toEqual(['booked']);
  expect(await states(vr2, 3, '12:00', '12:30')).toEqual(['booked']);
  // оба места заняты – комнату целиком на это время взять нельзя
  expect(await states(whole, 3, '12:00', '12:30')).toEqual(['booked']);
  await refused(A.hold(branch.id, slot(whole, 3, '12:15', '12:45')).then(async (h) => A.release(h.id)));
});

test('2. аренда комнаты целиком блокирует оба VR', async () => {
  const [w] = await book(A, [slot(whole, 4, '14:00', '15:00')]);
  expect(unitsOf(w!.id)).toEqual(['PS4', 'VR1', 'VR2']);
  expect(await states(vr1, 4, '14:00', '15:00')).toEqual(['booked']);
  expect(await states(vr2, 4, '14:00', '15:00')).toEqual(['booked']);
  await refused(B.hold(branch.id, slot(vr1, 4, '14:15', '14:30')).then(async (h) => B.release(h.id)));
  await refused(B.hold(branch.id, slot(vr2, 4, '14:45', '15:00')).then(async (h) => B.release(h.id)));
  // за краем аренды места свободны
  expect(await states(vr1, 4, '15:00', '15:15')).toEqual(['free']);
});

test('3. PS4 отдельно не бронируется: своего ресурса нет, ни сайт, ни API его не дают', async () => {
  const room = all.filter((r) => r.roomSlug === 'vr-ps4-room');
  expect(room.map((r) => r.name).sort()).toEqual(['VR-комната целиком', 'VR1', 'VR2']);
  expect(all.some((r) => /ps4/i.test(r.name))).toBe(false);
  // единица PS4 есть только как часть «комнаты целиком»
  const [ps4] = sql(`SELECT id FROM app.occupancy_units WHERE branch_id = '${branch.id}' AND code = 'PS4'`);
  expect(ps4).toMatch(/^[0-9a-f-]{36}$/);
  const e = (await A.hold(branch.id, { ...slot(vr1, 9, '16:00', '16:30'), resourceId: ps4! }).then(() => null, (x: unknown) => x)) as ApiErr | null;
  expect(e, 'удержание по единице PS4 должно быть отклонено').not.toBeNull();
  expect([404, 409, 422]).toContain(e!.status);
  const resources = sql(`SELECT r.resource_type FROM app.resource_units ru JOIN app.resources r ON r.id = ru.resource_id
                         WHERE ru.unit_id = '${ps4}' AND ru.valid_to IS NULL`);
  expect(resources).toEqual(['room_whole']);
});

test('4. отдельный VR и комната целиком не пересекаются – в обе стороны', async () => {
  await book(A, [slot(vr1, 5, '16:00', '16:30')]);
  // B не может взять комнату на пересекающееся время, VR2 при этом свободен
  await refused(B.hold(branch.id, slot(whole, 5, '16:15', '17:00')).then(async (h) => B.release(h.id)));
  expect(await states(whole, 5, '16:00', '16:30')).toEqual(['booked']);
  expect(await states(vr2, 5, '16:00', '16:30')).toEqual(['free']);
  // и наоборот: комната у B с 17:00 – VR1 в это время A не получит
  await book(B, [slot(whole, 5, '17:00', '18:00')]);
  await refused(A.hold(branch.id, slot(vr1, 5, '17:30', '17:45')).then(async (h) => A.release(h.id)));
});

test('5. отмена освобождает ресурсы', async () => {
  const [w] = await book(A, [slot(whole, 6, '18:00', '19:00')]);
  expect(await states(vr1, 6, '18:00', '19:00')).toEqual(['booked']);
  const c = await A.cancel(w!.id);
  expect(c.status).toBe('cancelled_by_client');
  expect(unitsOf(w!.id)).toEqual([]);
  expect(await states(vr1, 6, '18:00', '19:00')).toEqual(['free']);
  expect(await states(vr2, 6, '18:00', '19:00')).toEqual(['free']);
  expect(await states(whole, 6, '18:00', '19:00')).toEqual(['free']);
  // освободившееся место реально берётся
  const [v] = await book(B, [slot(vr1, 6, '18:00', '18:30')]);
  expect(v!.status).toBe('confirmed');
});

test('6. отмена одной записи не снимает независимую чужую бронь', async () => {
  // VR1 у A и VR2 у B в одно время: A отменяет – бронь B на месте
  const [a] = await book(A, [slot(vr1, 8, '11:00', '11:30')]);
  const [b] = await book(B, [slot(vr2, 8, '11:00', '11:30')]);
  await A.cancel(a!.id);
  expect((await B.my('upcoming')).items.find((x) => x.id === b!.id)?.status).toBe('confirmed');
  expect(await states(vr2, 8, '11:00', '11:30')).toEqual(['booked']);
  expect(await states(vr1, 8, '11:00', '11:30')).toEqual(['free']);
  expect(unitsOf(b!.id)).toEqual(['VR2']);
  // комната целиком у A встык перед VR1 у B: отмена комнаты не трогает бронь B
  const [w] = await book(A, [slot(whole, 8, '13:00', '14:00')]);
  const [v] = await book(B, [slot(vr1, 8, '14:00', '14:15')]);
  await A.cancel(w!.id);
  expect((await B.my('upcoming')).items.find((x) => x.id === v!.id)?.status).toBe('confirmed');
  expect(unitsOf(v!.id)).toEqual(['VR1']);
  expect(await states(vr1, 8, '14:00', '14:15')).toEqual(['booked']);
  expect(await states(vr1, 8, '13:00', '14:00')).toEqual(['free']);
});
