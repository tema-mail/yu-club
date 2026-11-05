// S4-52: событие смены слага → история адресов. Настоящие команды network и resources + processEvent: двойная доставка – одна строка;
// переименование города → старые адреса города, филиала и комнаты разрешаются в новые; до доставки старый адрес не найден (окно K23 §5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, listSubscriptions, processEvent } from '../../apps/api/src/core/outbox.ts';
import { registerContentHandlers, SLUG_HANDLERS } from '../../apps/api/src/modules/content/handlers.ts';
import { resolveLegacyPath, slugHistory } from '../../apps/api/src/modules/content/paths.ts';
import { createBranch, createCity, updateBranch, updateCity } from '../../apps/api/src/modules/network/commands.ts';
import { createEntity, updateEntity } from '../../apps/api/src/modules/resources/routes.ts';
import { clock, contentFixture, NOW, type ContentFixture } from '../helpers/content.ts';

let f: ContentFixture;
const resolve = async (path: string) => (await resolveLegacyPath(f.pool, path, NOW))?.location ?? null;
const eventOf = async (type: string, id: string) => (await f.db.client.query<{ id: string }>(`SELECT id FROM app.outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id DESC LIMIT 1`, [type, id])).rows[0]!.id;

beforeAll(async () => {
  f = await contentFixture();
  clearSubscriptions();
  registerContentHandlers({ clock });
  registerContentHandlers({ clock }); // повтор – без ошибки
});
afterAll(async () => {
  clearSubscriptions();
  await f.close();
});

describe('обработчики истории адресов', () => {
  it('три подписки со стабильными именами', () => {
    expect(listSubscriptions().map((s) => [s.type, s.name])).toEqual([
      ['city.slug_changed', SLUG_HANDLERS.city],
      ['branch.slug_changed', SLUG_HANDLERS.branch],
      ['room.slug_changed', SLUG_HANDLERS.room],
    ]);
  });

  it('город → старые адреса города, филиала и комнаты ведут на новые; двойная доставка – одна строка', async () => {
    const c = f.owner();
    const city = await f.inTx((t) => createCity(t, c, { slug: 'old-city', name: 'Город', timezone: 'Asia/Novosibirsk' }, f.meta(c), clock));
    const b1 = await f.inTx((t) => createBranch(t, c, { cityId: city.id, slug: 'lenina', name: 'Ленина', address: 'а' }, f.meta(c), clock));
    await f.inTx((t) => createBranch(t, c, { cityId: city.id, slug: 'mira', name: 'Мира', address: 'а' }, f.meta(c), clock));
    await f.db.client.query(`UPDATE app.branches SET status = 'active' WHERE city_id = $1`, [city.id]);
    const room = await f.inTx((t) => createEntity(t, c, 'room', b1.id, { slug: 'vr', name: 'VR', isPublished: true }, f.meta(c), clock));

    await f.inTx((t) => updateCity(t, c, city.id, { rowVersion: city.rowVersion, slug: 'new-city' }, f.meta(c), clock));
    expect(await resolve('/old-city/lenina/')).toBeNull(); // событие ещё не доставлено: принятое окно K23 §5
    const ev = await eventOf('city.slug_changed', city.id);
    await processEvent(f.pool, SLUG_HANDLERS.city, ev, clock.now());
    await processEvent(f.pool, SLUG_HANDLERS.city, ev, clock.now());
    expect((await slugHistory(f.pool, 'city', city.id)).map((h) => h.oldSlug)).toEqual(['old-city']);
    expect(await resolve('/old-city/')).toBe('/new-city/');
    expect(await resolve('/old-city/lenina/')).toBe('/new-city/lenina/');
    expect(await resolve('/old-city/lenina/rooms/vr/')).toBe('/new-city/lenina/rooms/vr/');

    const fresh = (await f.db.client.query<{ row_version: number }>(`SELECT row_version FROM app.branches WHERE id = $1`, [b1.id])).rows[0]!.row_version;
    await f.inTx((t) => updateBranch(t, c, b1.id, { rowVersion: fresh, slug: 'lenina-12' }, f.meta(c), clock));
    await processEvent(f.pool, SLUG_HANDLERS.branch, await eventOf('branch.slug_changed', b1.id), clock.now());
    await f.inTx((t) => updateEntity(t, c, 'room', room.id, { rowVersion: room.rowVersion, slug: 'vr-big' }, f.meta(c), clock));
    await processEvent(f.pool, SLUG_HANDLERS.room, await eventOf('room.slug_changed', room.id), clock.now());
    expect(await resolve('/old-city/lenina/rooms/vr/')).toBe('/new-city/lenina-12/rooms/vr-big/');
    expect(await resolve('/new-city/lenina/')).toBe('/new-city/lenina-12/');
    expect(await resolve('/new-city/lenina-12/rooms/vr-big/')).toBeNull();
  });
});
