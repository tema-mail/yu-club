// S4-51: смена слага города, филиала, комнаты → одно событие K4 в той же транзакции; правка без смены слага – события нет;
// откат транзакции уносит событие; K23 §3: маска, длина и зарезервированные слова – до записи (SLUG_INVALID, SLUG_RESERVED).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createBranch, createCity, updateBranch, updateCity } from '../../apps/api/src/modules/network/commands.ts';
import { createEntity, updateEntity } from '../../apps/api/src/modules/resources/routes.ts';
import { clock, contentFixture, type ContentFixture } from '../helpers/content.ts';

let f: ContentFixture;
const events = async (type: string, id: string) =>
  (await f.db.client.query<{ payload: unknown; aggregate_type: string; branch_id: string | null }>(`SELECT payload, aggregate_type, branch_id FROM app.outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY id`, [type, id])).rows;
const code = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof AppError ? e.code : `нет AppError: ${String(e)}`));
const newCity = (slug: string) => {
  const c = f.owner();
  return f.inTx((t) => createCity(t, c, { slug, name: slug, timezone: 'Asia/Novosibirsk' }, f.meta(c), clock));
};
const newBranch = (cityId: string, slug: string) => {
  const c = f.owner();
  return f.inTx((t) => createBranch(t, c, { cityId, slug, name: slug, address: 'адрес' }, f.meta(c), clock));
};

beforeAll(async () => {
  f = await contentFixture();
});
afterAll(async () => {
  await f.close();
});

describe('события смены слага', () => {
  it('город: одно событие со старым слагом; правка без смены – нет; тот же слаг в запросе – нет', async () => {
    const c = f.owner();
    const city = await newCity('ev-city');
    const named = await f.inTx((t) => updateCity(t, c, city.id, { rowVersion: city.rowVersion, name: 'Новое имя' }, f.meta(c), clock));
    const same = await f.inTx((t) => updateCity(t, c, city.id, { rowVersion: named.rowVersion, slug: 'ev-city' }, f.meta(c), clock));
    expect(await events('city.slug_changed', city.id)).toEqual([]);
    await f.inTx((t) => updateCity(t, c, city.id, { rowVersion: same.rowVersion, slug: 'ev-city-2' }, f.meta(c), clock));
    expect(await events('city.slug_changed', city.id)).toEqual([
      { aggregate_type: 'city', branch_id: null, payload: { id: city.id, parentId: null, oldSlug: 'ev-city', newSlug: 'ev-city-2' } },
    ]);
  });

  it('филиал: parentId – город; правка без смены – нет', async () => {
    const c = f.owner();
    const city = await newCity('ev-branch-city');
    const b = await newBranch(city.id, 'ev-b');
    const named = await f.inTx((t) => updateBranch(t, c, b.id, { rowVersion: b.rowVersion, name: 'Другое' }, f.meta(c), clock));
    expect(await events('branch.slug_changed', b.id)).toEqual([]);
    await f.inTx((t) => updateBranch(t, c, b.id, { rowVersion: named.rowVersion, slug: 'ev-b-2' }, f.meta(c), clock));
    expect(await events('branch.slug_changed', b.id)).toEqual([
      { aggregate_type: 'branch', branch_id: b.id, payload: { id: b.id, parentId: city.id, oldSlug: 'ev-b', newSlug: 'ev-b-2' } },
    ]);
  });

  it('комната: parentId – филиал; правка имени – нет; у других видов объектов событий нет', async () => {
    const c = f.owner();
    const city = await newCity('ev-room-city');
    const b = await newBranch(city.id, 'ev-r');
    const room = await f.inTx((t) => createEntity(t, c, 'room', b.id, { slug: 'vr-1', name: 'VR' }, f.meta(c), clock));
    const named = await f.inTx((t) => updateEntity(t, c, 'room', room.id, { rowVersion: room.rowVersion, name: 'VR большая' }, f.meta(c), clock));
    expect(await events('room.slug_changed', room.id)).toEqual([]);
    await f.inTx((t) => updateEntity(t, c, 'room', room.id, { rowVersion: named.rowVersion, slug: 'vr-2' }, f.meta(c), clock));
    expect(await events('room.slug_changed', room.id)).toEqual([
      { aggregate_type: 'room', branch_id: b.id, payload: { id: room.id, parentId: b.id, oldSlug: 'vr-1', newSlug: 'vr-2' } },
    ]);
  });

  it('откат транзакции уносит и смену, и событие; занятый слаг события не даёт', async () => {
    const c = f.owner();
    const city = await newCity('ev-roll');
    await newCity('ev-busy');
    await expect(
      f.inTx(async (t) => {
        await updateCity(t, c, city.id, { rowVersion: city.rowVersion, slug: 'ev-roll-2' }, f.meta(c), clock);
        throw new Error('сбой команды');
      }),
    ).rejects.toThrow('сбой команды');
    expect(await events('city.slug_changed', city.id)).toEqual([]);
    expect(await code(f.inTx((t) => updateCity(t, c, city.id, { rowVersion: city.rowVersion, slug: 'ev-busy' }, f.meta(c), clock)))).toBe('NETWORK_SLUG_TAKEN');
    expect(await events('city.slug_changed', city.id)).toEqual([]);
  });
});

describe('проверка слага у владельцев (K23 §3)', () => {
  it('город news – SLUG_RESERVED при создании и смене; в БД – 23514', async () => {
    const c = f.owner();
    expect(await code(newCity('news'))).toBe('SLUG_RESERVED');
    const city = await newCity('reserved-check');
    expect(await code(f.inTx((t) => updateCity(t, c, city.id, { rowVersion: city.rowVersion, slug: 'privacy-policy' }, f.meta(c), clock)))).toBe('SLUG_RESERVED');
    const err = await f.db.client.query(`UPDATE app.cities SET slug = 'news' WHERE id = $1`, [city.id]).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe('23514');
  });

  it('маска и длина: двойной дефис и дефис с края – SLUG_INVALID; город длиннее 40 – SLUG_INVALID; кириллица – как раньше VALIDATION_FAILED', async () => {
    const c = f.owner();
    expect(await code(newCity('a--b'))).toBe('SLUG_INVALID');
    expect(await code(newCity('-a'))).toBe('SLUG_INVALID');
    expect(await code(newCity('a'.repeat(41)))).toBe('SLUG_INVALID');
    expect(await code(newCity('Плохой'))).toBe('VALIDATION_FAILED');
    const city = await newCity('mask-city');
    expect(await code(newBranch(city.id, 'b--b'))).toBe('SLUG_INVALID');
    const b = await newBranch(city.id, 'mask-b');
    expect(await code(f.inTx((t) => updateBranch(t, c, b.id, { rowVersion: b.rowVersion, slug: 'b-' }, f.meta(c), clock)))).toBe('SLUG_INVALID');
    expect(await code(f.inTx((t) => createEntity(t, c, 'room', b.id, { slug: 'r--1', name: 'R' }, f.meta(c), clock)))).toBe('SLUG_INVALID');
  });
});
