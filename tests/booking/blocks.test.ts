// S1-04: блокировки ресурсов (K6 createBlock / assertNotBlocked, K11 №13–14, 01 §13) на настоящей Postgres.
// Блокировка поверх будущей брони не удаляет её, а возвращает в список; новые занятия – RESOURCE_BLOCKED;
// чужой филиал – отказ с записью в аудит; гонка «блокировка ↔ занятие» 100 раз.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, interval } from '../../apps/api/src/core/time.ts';
import { createBlock } from '../../apps/api/src/modules/booking/blocks.ts';
import { occupy, runOccupancyCommand } from '../../apps/api/src/modules/booking/occupancy.ts';
import { expandToUnits } from '../../apps/api/src/modules/resources/index.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-блокировок-проверка-1';
const BASE = '/api/crm/v1';
const NOW = '2026-11-14T05:00:00Z';
const clock = fixedClock(NOW);
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const units: Record<string, string> = {};

async function login(key: string, role: string, branchId?: string): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  if (branchId) {
    await db.client.query(
      `INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`,
      [r.rows[0]!.id, branchId],
    );
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
  return r.rows[0]!.id;
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const at = (iso: string) => new Date(iso);
const slot = (iso: string, minutes: number) => interval(at(iso), new Date(at(iso).getTime() + minutes * 60_000));
const booking = () => ({ type: 'booking' as const, id: randomUUID(), version: 1 });
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
}
async function book(resourceId: string, iso: string, minutes: number): Promise<string> {
  const src = booking();
  const u = await expandToUnits(pool, resourceId, at(iso));
  await runOccupancyCommand(pool, (c) => occupy(c, { branchId: ids.branch!, units: u, period: slot(iso, minutes), source: src, clientId: null }));
  return src.id;
}
const tryBook = async (resourceId: string, iso: string, minutes: number) => codeOf(book(resourceId, iso, minutes));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 12 });
  app = buildServer(loadConfig({ LOG_LEVEL: 'silent' }), { staff: { pool, auth: staffAuthConfig('b'.repeat(40)), clock } });
  const c = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'НСК', 'Asia/Novosibirsk') RETURNING id`);
  for (const k of ['branch', 'other']) {
    const b = await db.client.query<{ id: string }>(
      `INSERT INTO app.branches (city_id, code, slug, name, address, timezone, status) VALUES ($1, $2, $2, $2, 'адрес', 'Asia/Novosibirsk', 'active') RETURNING id`,
      [c.rows[0]!.id, k],
    );
    ids[k] = b.rows[0]!.id;
  }
  ids.owner = await login('owner', 'owner');
  ids.admin = await login('admin', 'admin', ids.branch);
  ids.foreign = await login('foreign', 'admin', ids.other);
  const reasons = await db.client.query<{ code: string; id: string }>(`SELECT code, id FROM app.dict_reasons WHERE domain IN ('resource_block', 'no_show')`);
  for (const r of reasons.rows) ids[`reason_${r.code}`] = r.id;
  const room = await req('owner', 'POST', `/branches/${ids.branch}/rooms`, { slug: 'vr', name: 'VR-комната', isPublished: true });
  ids.room = room.json().id;
  for (const code of ['VR1', 'VR2']) {
    const r = await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'vr_seat', name: code, roomId: ids.room, unitCode: code });
    ids[code] = r.json().id;
    units[code] = r.json().unitIds[0];
  }
  units.PS4 = (await req('owner', 'POST', `/branches/${ids.branch}/units`, { roomId: ids.room, code: 'PS4', name: 'PS4' })).json().id;
  ids.whole = (await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'room_whole', name: 'Комната', roomId: ids.room, unitIds: [units.VR1, units.VR2, units.PS4] })).json().id;
  ids.pc = (await req('owner', 'POST', `/branches/${ids.branch}/resources`, { type: 'pc', name: 'ПК-1' })).json().id;
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('блокировка поверх броней (01 §13)', () => {
  it('Администратор блокирует VR-место: будущие брони места и комнаты – в списке и остаются активными', async () => {
    ids.roomBooking = await book(ids.whole!, '2026-11-15T10:00:00Z', 60);
    ids.seatBooking = await book(ids.VR1!, '2026-11-15T12:00:00Z', 30);
    ids.otherSeat = await book(ids.VR2!, '2026-11-15T12:00:00Z', 30);
    const r = await req('admin', 'POST', `/branches/${ids.branch}/blocks`, {
      target: { type: 'resource', ids: [ids.VR1] }, start: '2026-11-15T10:30:00Z', end: '2026-11-15T14:00:00Z', reasonId: ids.reason_repair,
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.affectedBookingIds.sort()).toEqual([ids.roomBooking, ids.seatBooking].sort());
    expect(body.affectedHoldIds).toEqual([]);
    expect(body.block).toMatchObject({ targetType: 'resource', status: 'active', unitIds: [units.VR1], rowVersion: 1 });
    ids.block = body.block.id;
    const live = await db.client.query(`SELECT count(*)::int n FROM app.occupancy WHERE active AND source_id = ANY($1::uuid[])`, [[ids.roomBooking, ids.seatBooking]]);
    expect(live.rows[0].n).toBe(4); // комната – 3 строки, место – 1: ничего не погашено
    const a = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'block.created' AND object_id = $1`, [ids.block]);
    expect(a.rows[0].after.affectedBookingIds.sort()).toEqual([ids.roomBooking, ids.seatBooking].sort());
    // не в блокировке: ресурс/блокировки в occupancy не пишутся
    expect((await db.client.query(`SELECT count(*)::int n FROM app.occupancy WHERE source_id = $1`, [ids.block])).rows[0].n).toBe(0);
  });

  it('новые занятия на заблокированную единицу – RESOURCE_BLOCKED; соседняя единица и вне периода – можно', async () => {
    expect(await tryBook(ids.VR1!, '2026-11-15T13:00:00Z', 30)).toBe('RESOURCE_BLOCKED');
    expect(await tryBook(ids.whole!, '2026-11-15T13:30:00Z', 30)).toBe('RESOURCE_BLOCKED'); // комната включает VR1
    expect(await tryBook(ids.VR2!, '2026-11-15T13:00:00Z', 30)).toBe('ok');
    expect(await tryBook(ids.VR1!, '2026-11-15T14:00:00Z', 30)).toBe('ok'); // встык '[)'
  });

  it('блокировка комнаты – все её единицы, включая PS4 без ресурса; блокировка PS4 закрывает только комнату', async () => {
    const r = await req('admin', 'POST', `/branches/${ids.branch}/blocks`, {
      target: { type: 'room', ids: [ids.room] }, start: '2026-11-16T10:00:00Z', end: '2026-11-16T11:00:00Z', reasonId: ids.reason_maintenance,
    });
    expect(r.json().block.unitIds).toEqual([units.VR1, units.VR2, units.PS4].sort());
    await req('admin', 'POST', `/branches/${ids.branch}/blocks`, {
      target: { type: 'unit', ids: [units.PS4] }, start: '2026-11-16T12:00:00Z', end: '2026-11-16T13:00:00Z', reasonId: ids.reason_repair,
    });
    expect(await tryBook(ids.whole!, '2026-11-16T12:00:00Z', 30)).toBe('RESOURCE_BLOCKED');
    expect(await tryBook(ids.VR1!, '2026-11-16T12:00:00Z', 30)).toBe('ok');
    expect(await tryBook(ids.pc!, '2026-11-16T10:00:00Z', 30)).toBe('ok');
    const many = await req('admin', 'POST', `/branches/${ids.branch}/blocks`, {
      target: { type: 'resources', ids: [ids.VR2, ids.pc] }, start: '2026-11-17T10:00:00Z', end: '2026-11-17T11:00:00Z', reasonId: ids.reason_repair,
    });
    expect(many.json().block.unitIds.length).toBe(2);
  });

  it('снятие: занятие снова проходит; повтор снятия – без изменений; аудит block.lifted', async () => {
    const lift = await req('admin', 'POST', `/blocks/${ids.block}/lift`, { rowVersion: 1, comment: 'починили' });
    expect(lift.statusCode).toBe(200);
    expect(lift.json()).toMatchObject({ status: 'lifted', rowVersion: 2 });
    expect(await tryBook(ids.VR1!, '2026-11-15T13:00:00Z', 30)).toBe('ok');
    const again = await req('admin', 'POST', `/blocks/${ids.block}/lift`, { rowVersion: 1 });
    expect(again.json()).toMatchObject({ status: 'lifted', rowVersion: 2 });
    const a = await db.client.query(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'block.lifted' AND object_id = $1 AND result = 'success'`, [ids.block]);
    expect(a.rows[0].n).toBe(1);
  });

  it('проверки ввода: причина не из домена блокировок, «Другое» без комментария, конец раньше начала, чужая цель', async () => {
    const base = { target: { type: 'resource', ids: [ids.pc] }, start: '2026-11-18T10:00:00Z', end: '2026-11-18T11:00:00Z' };
    expect((await req('admin', 'POST', `/branches/${ids.branch}/blocks`, { ...base, reasonId: ids.reason_other })).statusCode).toBe(400);
    expect((await req('admin', 'POST', `/branches/${ids.branch}/blocks`, { ...base, reasonId: ids.reason_other, comment: 'кабель' })).statusCode).toBe(201);
    const noShow = (await db.client.query(`SELECT id FROM app.dict_reasons WHERE domain = 'no_show'`)).rows[0].id;
    expect((await req('admin', 'POST', `/branches/${ids.branch}/blocks`, { ...base, reasonId: noShow })).statusCode).toBe(400);
    expect((await req('admin', 'POST', `/branches/${ids.branch}/blocks`, { ...base, end: '2026-11-18T09:00:00Z', reasonId: ids.reason_repair })).statusCode).toBe(400);
    const foreignRoom = (await req('owner', 'POST', `/branches/${ids.other}/rooms`, { slug: 'x', name: 'X' })).json().id;
    const r = await req('admin', 'POST', `/branches/${ids.branch}/blocks`, { ...base, target: { type: 'room', ids: [foreignRoom] }, reasonId: ids.reason_repair });
    expect(r.json().error.code).toBe('RESOURCE_LINK_INVALID');
  });
});

describe('права (K1 block.manage)', () => {
  it('Администратор чужого филиала – 404 как несуществующий, отказ в аудите; снять чужую – 404', async () => {
    const body = { target: { type: 'resource', ids: [ids.VR1] }, start: '2026-11-19T10:00:00Z', end: '2026-11-19T11:00:00Z', reasonId: ids.reason_repair };
    const r = await req('foreign', 'POST', `/branches/${ids.branch}/blocks`, body);
    const missing = await req('foreign', 'POST', `/branches/${randomUUID()}/blocks`, body);
    expect(r.statusCode).toBe(404);
    expect({ ...r.json().error, requestId: 0 }).toEqual({ ...missing.json().error, requestId: 0 });
    const a = await db.client.query(`SELECT action, reason FROM journal.audit_events WHERE result = 'denied' AND actor_id = $1 AND branch_id = $2`, [ids.foreign, ids.branch]);
    expect(a.rows).toContainEqual({ action: 'block.created', reason: 'NOT_FOUND: block.manage' });
    expect((await req('foreign', 'POST', `/blocks/${ids.block}/lift`, { rowVersion: 2 })).statusCode).toBe(404);
    expect(await tryBook(ids.VR1!, '2026-11-19T10:00:00Z', 30)).toBe('ok'); // блокировка не создана
  });

  it('роль без block.manage – отказ (функция; роль вне реестра K1 не видит филиал – NOT_FOUND)', async () => {
    const meta: AuditRequestMeta = { actor: { kind: 'staff', staffId: ids.admin!, sessionId: randomUUID() }, source: 'crm', requestId: 'x' };
    // в Э1 block.manage есть у всех ролей (R-14); роль вне реестра K1 – не имеет никаких прав
    const ctx = { actor: meta.actor, role: 'cashier', network: false, cityIds: new Set(), branchIds: new Set([ids.branch]), at: at(NOW) } as unknown as AccessContext;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const code = await codeOf(createBlock(c, ctx, { branchId: ids.branch!, target: { type: 'resource', ids: [ids.pc!] }, period: slot('2026-11-20T10:00:00Z', 60), reasonId: ids.reason_repair! }, meta, clock));
      expect(code).toBe('NOT_FOUND');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('Директор и блокировки (ревизия S1-04 п.3–4)', () => {
  it('Директор своего города блокирует – 201; Директор чужого города – 404', async () => {
    const tsk = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('tsk', 'tsk', 'Томск', 'Asia/Tomsk') RETURNING id`);
    const nsk = (await db.client.query<{ city_id: string }>('SELECT city_id FROM app.branches WHERE id = $1', [ids.branch])).rows[0]!.city_id;
    for (const [key, city] of [['director', nsk], ['director_tsk', tsk.rows[0]!.id]] as const) {
      const r = await db.client.query<{ id: string }>(
        `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, 'director', $2) RETURNING id`,
        [`${key}@yu.test`, await hashPassword(PASSWORD)],
      );
      await db.client.query(
        `INSERT INTO app.staff_assignments (staff_id, scope_type, city_id, valid_from, created_by) VALUES ($1, 'city', $2, '2026-01-01', $1)`,
        [r.rows[0]!.id, city],
      );
      const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
      cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
    }
    const body = { target: { type: 'resource', ids: [ids.pc] }, start: '2026-11-21T10:00:00Z', end: '2026-11-21T11:00:00Z', reasonId: ids.reason_repair };
    expect((await req('director', 'POST', `/branches/${ids.branch}/blocks`, body)).statusCode).toBe(201);
    expect((await req('director_tsk', 'POST', `/branches/${ids.branch}/blocks`, body)).statusCode).toBe(404);
  });

  it('смена состава ресурса с активной блокировкой по нему – отказ со списком блокировок', async () => {
    const r = await req('owner', 'POST', `/branches/${ids.branch}/blocks`, {
      target: { type: 'resource', ids: [ids.whole] }, start: '2026-11-22T10:00:00Z', end: '2026-11-22T11:00:00Z', reasonId: ids.reason_repair,
    });
    const blockId = r.json().block.id;
    const c = await req('owner', 'POST', `/resources/${ids.whole}/composition`, { unitIds: [units.VR1, units.VR2], validFrom: '2026-11-22T00:00:00Z' });
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toMatchObject({ code: 'COMPOSITION_HAS_FUTURE_BOOKINGS', details: { blockIds: [blockId] } });
  });
});

describe('гонка «блокировка ↔ занятие» (K6 §Проверка)', () => {
  it('100 пар: либо RESOURCE_BLOCKED у занятия, либо бронь в affectedBookingIds блокировки', async () => {
    const ownerCtx: AccessContext = {
      actor: { kind: 'staff', staffId: ids.owner!, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: at(NOW),
    };
    const meta: AuditRequestMeta = { actor: ownerCtx.actor, access: ownerCtx, source: 'crm', requestId: 'race' };
    const seat = await expandToUnits(pool, ids.VR2!, at('2026-12-01T00:00:00Z'));
    const outcomes = { blocked: 0, listed: 0 };
    for (let k = 0; k < 100; k++) {
      const p = slot(new Date(at('2026-12-01T00:00:00Z').getTime() + k * 3_600_000).toISOString(), 30);
      const src = booking();
      const [occ, blk] = await Promise.all([
        codeOf(runOccupancyCommand(pool, (c) => occupy(c, { branchId: ids.branch!, units: seat, period: p, source: src, clientId: null }))),
        runOccupancyCommand(pool, (c) => createBlock(c, ownerCtx, { branchId: ids.branch!, target: { type: 'unit', ids: [units.VR2!] }, period: p, reasonId: ids.reason_repair! }, meta, clock)),
      ]);
      if (occ === 'RESOURCE_BLOCKED') {
        expect(blk.affectedBookingIds).not.toContain(src.id);
        outcomes.blocked++;
      } else {
        expect(occ).toBe('ok');
        expect(blk.affectedBookingIds).toContain(src.id);
        outcomes.listed++;
      }
    }
    expect(outcomes.blocked + outcomes.listed).toBe(100);
  }, 60_000);
});
