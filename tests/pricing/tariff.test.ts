// S1-14: базовый тариф – цена брони со снимком (K6 quote), нет тарифа → ошибка, не 0 ₽; два тарифа одного приоритета –
// ошибка до сохранения; смена тарифа не меняет цену уже посчитанной брони; права tariff.manage и аудит.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  archiveTariff,
  createTariff,
  listTariffs,
  priceOf,
  quote,
  tariffDenialOf,
  updateTariff,
  type Tariff,
} from '../../apps/api/src/modules/pricing/tariff.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');
const ids: Record<string, string> = {};

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return {
    actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: clock.now(),
  };
}
const owner = ctx('owner');
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

const create = (body: Record<string, unknown>, who: AccessContext = owner) =>
  tx((t) => createTariff(t, who, { branchId: ids.arbat, resourceType: 'pc', name: 'ПК базовый', unitMinutes: 30, pricePerUnitKop: 15_000, validFrom: '2026-01-01T00:00:00Z', ...body }, meta(who), clock));
const START = new Date('2026-11-20T15:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const c = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('msk', 'msk', 'Москва', 'Europe/Moscow') RETURNING id`);
  for (const slug of ['arbat', 'tverskaya']) {
    const b = await db.client.query<{ id: string }>(
      `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Europe/Moscow', 'active') RETURNING id`,
      [c.rows[0]!.id, slug],
    );
    ids[slug] = b.rows[0]!.id;
  }
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('quote: нет тарифа → TARIFF_NOT_CONFIGURED, не 0 ₽', () => {
  it('пустая база, чужой филиал, чужой тип, неверный id – ошибка конфигурации', async () => {
    const e = await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: START, durationMinutes: 60 }), 'TARIFF_NOT_CONFIGURED');
    expect(e.httpStatus).toBe(422);
    expect(e.details).toMatchObject({ resourceType: 'pc', durationMinutes: 60 });
    await fails(quote(pool, { branchId: 'не-uuid', resourceType: 'pc', start: START, durationMinutes: 60 }), 'TARIFF_NOT_CONFIGURED');
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: START, durationMinutes: 0 }), 'INVALID_DURATION');
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: START, durationMinutes: 1.5 }), 'INVALID_DURATION');
  });

  it('тариф ПК 150 ₽ за 30 мин: 60 мин = 300 ₽, 90 мин = 450 ₽, снимок для брони', async () => {
    const t = await create({});
    ids.pc = t.id;
    expect(await quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: START, durationMinutes: 60 })).toEqual({
      tariffId: t.id,
      priceKop: 30_000,
      snapshot: { tariffName: 'ПК базовый', unitMinutes: 30, pricePerUnitKop: 15_000, units: 2 },
    });
    expect((await quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: START, durationMinutes: 90 })).priceKop).toBe(45_000);
    await fails(quote(pool, { branchId: ids.tverskaya!, resourceType: 'pc', start: START, durationMinutes: 60 }), 'TARIFF_NOT_CONFIGURED');
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'vr_seat', start: START, durationMinutes: 60 }), 'TARIFF_NOT_CONFIGURED');
  });

  it('единица не делит длительность – округление вверх: 45 мин по 30 = 2 единицы', () => {
    expect(priceOf({ id: 't', name: 'n', unitMinutes: 30, pricePerUnitKop: 100 }, 45)).toMatchObject({ priceKop: 200, snapshot: { units: 2 } });
  });

  it('черновик и архив не применяются; период действия [from, to)', async () => {
    await create({ resourceType: 'vr_seat', name: 'VR черновик', unitMinutes: 15, status: 'draft' });
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'vr_seat', start: START, durationMinutes: 30 }), 'TARIFF_NOT_CONFIGURED');
    const ps = await create({ resourceType: 'ps_room', name: 'PS', validFrom: '2026-11-20T15:00:00Z', validTo: '2026-11-21T00:00:00Z' });
    expect((await quote(pool, { branchId: ids.arbat!, resourceType: 'ps_room', start: START, durationMinutes: 30 })).tariffId).toBe(ps.id);
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'ps_room', start: new Date('2026-11-20T14:59:59Z'), durationMinutes: 30 }), 'TARIFF_NOT_CONFIGURED');
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'ps_room', start: new Date('2026-11-21T00:00:00Z'), durationMinutes: 30 }), 'TARIFF_NOT_CONFIGURED');
    await tx((t) => archiveTariff(t, owner, ps.id, meta(owner), clock));
    await fails(quote(pool, { branchId: ids.arbat!, resourceType: 'ps_room', start: START, durationMinutes: 30 }), 'TARIFF_NOT_CONFIGURED');
  });
});

describe('два тарифа одного приоритета – ошибка до сохранения', () => {
  it('пересечение длительностей и дат при том же приоритете – TARIFF_PRIORITY_CONFLICT, запись не создана', async () => {
    const e = await fails(create({ name: 'ПК дубль', validFrom: '2026-06-01T00:00:00Z' }), 'TARIFF_PRIORITY_CONFLICT');
    expect(e.details).toEqual({ tariffId: ids.pc });
    const n = await db.client.query(`SELECT count(*)::int n FROM app.tariffs WHERE name = 'ПК дубль'`);
    expect(n.rows[0].n).toBe(0);
  });

  it('база тоже не даёт (EXCLUDE) – на случай гонки', async () => {
    await expect(
      db.client.query(
        `INSERT INTO app.tariffs (branch_id, resource_type, name, unit_minutes, price_per_unit_kop, valid_from, status, created_by)
         VALUES ($1, 'pc', 'обход', 30, 1, '2026-01-01', 'active', $2)`,
        [ids.arbat, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('другой приоритет – можно, выигрывает больший; другой диапазон длительности – можно', async () => {
    const long = await create({ name: 'ПК от 3 часов', durationFromMin: 180, priority: 0, pricePerUnitKop: 12_000 }).catch((e: AppError) => e);
    expect(long).toBeInstanceOf(AppError); // пересекается с базовым [0, ∞)
    const promo = await create({ name: 'ПК акция', priority: 10, pricePerUnitKop: 10_000, validFrom: '2026-11-20T00:00:00Z', validTo: '2026-11-21T00:00:00Z' });
    expect(await quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: START, durationMinutes: 60 })).toMatchObject({ tariffId: promo.id, priceKop: 20_000 });
    const vrShort = await create({ resourceType: 'room_whole', name: 'Комната до часа', unitMinutes: 15, durationToMin: 60 });
    const vrLong = await create({ resourceType: 'room_whole', name: 'Комната от часа', unitMinutes: 15, durationFromMin: 60, pricePerUnitKop: 12_000 });
    expect((await quote(pool, { branchId: ids.arbat!, resourceType: 'room_whole', start: START, durationMinutes: 45 })).tariffId).toBe(vrShort.id);
    expect((await quote(pool, { branchId: ids.arbat!, resourceType: 'room_whole', start: START, durationMinutes: 60 })).tariffId).toBe(vrLong.id);
  });

  it('включение черновика проверяется так же', async () => {
    const draft = await create({ name: 'ПК черновик', status: 'draft', validFrom: '2026-12-01T00:00:00Z' });
    await fails(tx((t) => updateTariff(t, owner, draft.id, { status: 'active' }, meta(owner), clock)), 'TARIFF_PRIORITY_CONFLICT');
  });
});

describe('смена тарифа не меняет цену созданной брони', () => {
  it('новая цена – новым тарифом с даты; посчитанный снимок и прежние моменты – старая цена; цену в базе не переписать', async () => {
    const before = await quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: new Date('2026-11-25T15:00:00Z'), durationMinutes: 60 });
    const frozen = JSON.stringify(before);
    const ended = await tx((t) => updateTariff(t, owner, ids.pc!, { validTo: '2026-12-01T00:00:00Z' }, meta(owner), clock));
    expect(ended.validTo?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    const next = await create({ name: 'ПК с декабря', pricePerUnitKop: 20_000, validFrom: '2026-12-01T00:00:00Z' });
    expect(JSON.stringify(before)).toBe(frozen);
    expect((await quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: new Date('2026-11-25T15:00:00Z'), durationMinutes: 60 })).priceKop).toBe(30_000);
    expect(await quote(pool, { branchId: ids.arbat!, resourceType: 'pc', start: new Date('2026-12-02T15:00:00Z'), durationMinutes: 60 })).toMatchObject({ tariffId: next.id, priceKop: 40_000 });
    const c = await pool.connect();
    try {
      await expect(c.query('UPDATE app.tariffs SET price_per_unit_kop = 1 WHERE id = $1', [ids.pc])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('DELETE FROM app.tariffs WHERE id = $1', [ids.pc])).rejects.toMatchObject({ code: '42501' });
    } finally {
      c.release();
    }
  });

  it('конец действия в прошлом или раньше начала – ошибка; архивный не меняется', async () => {
    await fails(tx((t) => updateTariff(t, owner, ids.pc!, { validTo: '2026-11-01T00:00:00Z' }, meta(owner), clock)), 'VALIDATION_FAILED');
    const a = await create({ resourceType: 'composite', name: 'Составная', unitMinutes: 15 });
    await tx((t) => archiveTariff(t, owner, a.id, meta(owner), clock));
    await fails(tx((t) => archiveTariff(t, owner, a.id, meta(owner), clock)), 'TARIFF_ARCHIVED');
    await fails(tx((t) => updateTariff(t, owner, a.id, { name: 'x' }, meta(owner), clock)), 'TARIFF_ARCHIVED');
  });
});

describe('права и аудит', () => {
  it('Директор и Администратор – FORBIDDEN (tariff.manage только Владелец); вне зоны – 404 как несуществующий', async () => {
    const director = ctx('director', [ids.arbat!]);
    const e = await fails(create({ resourceType: 'vr_seat', name: 'x', priority: 5 }, director), 'FORBIDDEN');
    expect(tariffDenialOf(e)).toMatchObject({ action: 'tariff.created', branchId: ids.arbat, reason: 'FORBIDDEN: tariff.manage' });
    await fails(tx((t) => archiveTariff(t, ctx('admin', [ids.arbat!]), ids.pc!, meta(owner), clock)), 'FORBIDDEN');
    await fails(tx((t) => archiveTariff(t, director, randomUUID(), meta(director), clock)), 'NOT_FOUND'); // несуществующий – 404 до роли
    await fails(create({ branchId: randomUUID() }), 'NOT_FOUND');
    await fails(create({ resourceType: 'нет-такого', name: 'x', priority: 7 }), 'VALIDATION_FAILED');
  });

  it('список: свой филиал видит Администратор, чужой – 404; фильтры', async () => {
    const admin = ctx('admin', [ids.arbat!]);
    const all = (await listTariffs(pool, admin, ids.arbat!, {})).items;
    expect(all.length).toBeGreaterThan(3);
    const pc = (await listTariffs(pool, admin, ids.arbat!, { resourceType: 'pc', status: 'active' })).items;
    expect(pc.every((t: Tariff) => t.resourceType === 'pc' && t.status === 'active')).toBe(true);
    await fails(listTariffs(pool, admin, ids.tverskaya!, {}), 'NOT_FOUND');
  });

  it('создание, изменение, архив – в аудите с объектом tariff', async () => {
    const r = await db.client.query(`SELECT action, count(*)::int n FROM journal.audit_events WHERE object_type = 'tariff' AND result = 'success' GROUP BY action ORDER BY action`);
    expect(r.rows.map((x) => x.action)).toEqual(['tariff.archived', 'tariff.created', 'tariff.updated']);
    const u = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'tariff.updated' AND object_id = $1`, [ids.pc]);
    expect(u.rows[0].before).toEqual({ validTo: null });
    expect(u.rows[0].after).toEqual({ validTo: '2026-12-01T00:00:00.000Z' });
  });
});
