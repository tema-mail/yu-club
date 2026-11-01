import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type LocalDate } from '../../apps/api/src/core/time.ts';
import {
  archiveBranch,
  archiveCity,
  changeBranchTimezone,
  createBranch,
  createCity,
  denialOf,
  getBranchCard,
  getCity,
  listBranches,
  listCities,
  setBranchStatus,
  updateBranch,
  updateCity,
  type BranchCard,
  type CityInfo,
} from '../../apps/api/src/modules/network/commands.ts';
import { setSetting } from '../../apps/api/src/core/settings.ts';
import { getBranch, openIntervals } from '../../apps/api/src/modules/network/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-14T05:00:00Z');

function ctx(role: StaffRole, scope: { cityIds?: string[]; branchIds?: string[] } = {}): AccessContext {
  return {
    actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(scope.cityIds ?? []),
    branchIds: new Set(scope.branchIds ?? []),
    at: clock.now(),
  };
}
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

const owner = ctx('owner');
let nsk: CityInfo;
let msk: CityInfo;
let krasny: BranchCard;
let akadem: BranchCard;
let arbat: BranchCard;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  nsk = await tx((t) => createCity(t, owner, { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' }, meta(owner), clock));
  msk = await tx((t) => createCity(t, owner, { slug: 'msk', name: 'Москва', timezone: 'Europe/Moscow' }, meta(owner), clock));
  krasny = await tx((t) => createBranch(t, owner, { cityId: nsk.id, slug: 'krasny', name: 'На Красном', address: 'Красный, 25' }, meta(owner), clock));
  akadem = await tx((t) => createBranch(t, owner, { cityId: nsk.id, slug: 'akadem', name: 'Академ', address: 'Морской, 2' }, meta(owner), clock));
  arbat = await tx((t) => createBranch(t, owner, { cityId: msk.id, slug: 'arbat', name: 'Арбат', address: 'Арбат, 1', sortOrder: 1 }, meta(owner), clock));
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('Владелец создаёт город и филиал', () => {
  it('филиал: «готовится», зона города, код по умолчанию, 7 строк графика 10:00–22:00 с сегодняшней даты', async () => {
    expect(krasny).toMatchObject({ status: 'preparing', timezone: 'Asia/Novosibirsk', code: 'nsk-krasny', cityName: 'Новосибирск', rowVersion: 1 });
    const h = await db.client.query(
      `SELECT weekday, to_char(open_time,'HH24:MI') o, to_char(close_time,'HH24:MI') c, valid_from::text f FROM app.branch_weekly_hours WHERE branch_id = $1 ORDER BY weekday`,
      [krasny.id],
    );
    expect(h.rows).toHaveLength(7);
    expect(h.rows.every((r) => r.o === '10:00' && r.c === '22:00' && r.f === '2026-11-14')).toBe(true);
  });

  it('часы нового филиала – из настройки branch.default_hours города (K7), без неё – системные 10–22', async () => {
    await tx((t) =>
      setSetting(t, owner, { key: 'branch.default_hours', scope: { cityId: nsk.id }, value: { open: '09:00', close: '21:00' }, validFrom: clock.now() }, meta(owner), clock),
    );
    const b = await tx((t) => createBranch(t, owner, { cityId: nsk.id, slug: 'hours', name: 'Часы', address: 'a' }, meta(owner), clock));
    const h = await db.client.query(
      `SELECT DISTINCT to_char(open_time,'HH24:MI') o, to_char(close_time,'HH24:MI') c FROM app.branch_weekly_hours WHERE branch_id = $1`,
      [b.id],
    );
    expect(h.rows).toEqual([{ o: '09:00', c: '21:00' }]);
    await tx((t) => archiveBranch(t, owner, b.id, { rowVersion: 1 }, meta(owner), clock)); // не мешать спискам ниже
  });

  it('аудит city.created и branch.created с автором и филиалом', async () => {
    const a = await db.client.query(`SELECT action, actor_id, branch_id, city_id, after FROM journal.audit_events WHERE object_id = $1`, [krasny.id]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ action: 'branch.created', actor_id: owner.actor.staffId, branch_id: krasny.id, city_id: nsk.id });
    expect(a.rows[0].after).toMatchObject({ slug: 'krasny', timezone: 'Asia/Novosibirsk' });
    const c = await db.client.query(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'city.created'`);
    expect(c.rows[0].n).toBe(2);
  });

  it('неверная зона и занятый slug – понятные коды; город в архиве – CITY_ARCHIVED', async () => {
    await fails(tx((t) => createCity(t, owner, { slug: 'x', name: 'X', timezone: 'Mars/Olympus' }, meta(owner), clock)), 'INVALID_TIMEZONE');
    await fails(tx((t) => createCity(t, owner, { slug: 'nsk', name: 'X', timezone: 'Asia/Omsk' }, meta(owner), clock)), 'NETWORK_SLUG_TAKEN');
    await fails(tx((t) => createBranch(t, owner, { cityId: nsk.id, slug: 'krasny', name: 'X', address: 'a' }, meta(owner), clock)), 'NETWORK_SLUG_TAKEN');
    await fails(tx((t) => createCity(t, owner, { slug: 'Плохой', name: 'X', timezone: 'Asia/Omsk' }, meta(owner), clock)), 'VALIDATION_FAILED');
  });
});

describe('права и IDOR', () => {
  it('Директор и Администратор не создают город – FORBIDDEN с отметкой для аудита', async () => {
    for (const c of [ctx('director', { cityIds: [nsk.id] }), ctx('admin', { branchIds: [krasny.id] })]) {
      const err = await fails(tx((t) => createCity(t, c, { slug: 'omsk', name: 'Омск', timezone: 'Asia/Omsk' }, meta(c), clock)), 'FORBIDDEN');
      expect(denialOf(err)).toMatchObject({ action: 'city.created', object: { type: 'city' } });
    }
  });

  it('Администратор чужого филиала: карточка и изменение по прямому ID – NOT_FOUND, как у несуществующего', async () => {
    const admin = ctx('admin', { branchIds: [krasny.id] });
    await fails(getBranchCard(pool, admin, arbat.id), 'NOT_FOUND');
    await fails(getBranchCard(pool, admin, randomUUID()), 'NOT_FOUND');
    const err = await fails(tx((t) => updateBranch(t, admin, arbat.id, { rowVersion: 1, name: 'Взлом' }, meta(admin), clock)), 'NOT_FOUND');
    expect(denialOf(err)).toMatchObject({ action: 'branch.updated', object: { type: 'branch', id: arbat.id }, branchId: arbat.id });
    await fails(tx((t) => archiveBranch(t, admin, arbat.id, { rowVersion: 1 }, meta(admin), clock)), 'NOT_FOUND');
    await fails(tx((t) => createBranch(t, admin, { cityId: msk.id, slug: 'y', name: 'Y', address: 'a' }, meta(admin), clock)), 'NOT_FOUND');
    await fails(tx((t) => createBranch(t, admin, { cityId: nsk.id, slug: 'y', name: 'Y', address: 'a' }, meta(admin), clock)), 'FORBIDDEN');
    expect((await getBranch(pool, arbat.id))?.name).toBe('Арбат');
  });

  it('Администратор своего филиала видит его, но менять не может – FORBIDDEN', async () => {
    const admin = ctx('admin', { branchIds: [krasny.id] });
    expect((await getBranchCard(pool, admin, krasny.id)).id).toBe(krasny.id);
    await fails(tx((t) => updateBranch(t, admin, krasny.id, { rowVersion: 1, name: 'X' }, meta(admin), clock)), 'FORBIDDEN');
  });

  it('Директор города меняет карточку филиала города; чужой город – NOT_FOUND; устаревшая версия – VERSION_CONFLICT', async () => {
    const dir = ctx('director', { cityIds: [nsk.id], branchIds: [krasny.id, akadem.id] });
    const b = await tx((t) => updateBranch(t, dir, krasny.id, { rowVersion: 1, name: 'Ю Клуб на Красном', phonePublic: '+73830000000' }, meta(dir), clock));
    expect(b).toMatchObject({ name: 'Ю Клуб на Красном', rowVersion: 2 });
    krasny = b;
    await fails(tx((t) => updateBranch(t, dir, krasny.id, { rowVersion: 1, name: 'X' }, meta(dir), clock)), 'VERSION_CONFLICT');
    await fails(tx((t) => updateBranch(t, dir, arbat.id, { rowVersion: 1, name: 'X' }, meta(dir), clock)), 'NOT_FOUND');
    const a = await db.client.query(`SELECT before, after, actor_role FROM journal.audit_events WHERE action = 'branch.updated' AND object_id = $1`, [krasny.id]);
    expect(a.rows).toHaveLength(1);
    expect(Object.keys(a.rows[0].after).sort()).toEqual(['name', 'phonePublic']);
    expect(a.rows[0]).toMatchObject({ before: { name: 'На Красном', phonePublic: null }, actor_role: 'director' });
  });
});

describe('статус, архив, зона', () => {
  it('временное закрытие видно в BranchInfo; аудит branch.status_changed', async () => {
    const b = await tx((t) =>
      setBranchStatus(t, owner, akadem.id, { rowVersion: 1, status: 'temporarily_closed', from: '2026-11-20T00:00:00Z', to: '2026-11-25T00:00:00Z', reason: 'ремонт' }, meta(owner), clock),
    );
    expect(b.tempClosed).toEqual({ from: new Date('2026-11-20T00:00:00Z'), to: new Date('2026-11-25T00:00:00Z'), reason: 'ремонт' });
    akadem = b;
    const a = await db.client.query(`SELECT count(*)::int n FROM journal.audit_events WHERE action = 'branch.status_changed' AND object_id = $1`, [akadem.id]);
    expect(a.rows[0].n).toBe(1);
  });

  it('архив вместо удаления: город с филиалами не архивируется; филиал – в архив, строка остаётся; архивный не редактируется', async () => {
    await fails(tx((t) => archiveCity(t, owner, msk.id, { rowVersion: 1 }, meta(owner), clock)), 'CITY_HAS_ACTIVE_BRANCHES');
    const dir = ctx('director', { cityIds: [msk.id], branchIds: [arbat.id] });
    await fails(tx((t) => archiveBranch(t, dir, arbat.id, { rowVersion: 1 }, meta(dir), clock)), 'FORBIDDEN');
    const b = await tx((t) => archiveBranch(t, owner, arbat.id, { rowVersion: 1 }, meta(owner), clock));
    expect(b).toMatchObject({ status: 'archived', archivedAt: clock.now() });
    expect((await getBranch(pool, arbat.id))?.status).toBe('archived');
    await fails(tx((t) => updateBranch(t, owner, arbat.id, { rowVersion: b.rowVersion, name: 'X' }, meta(owner), clock)), 'BRANCH_ARCHIVED');
    const c = await tx((t) => archiveCity(t, owner, msk.id, { rowVersion: 1 }, meta(owner), clock));
    expect(c.status).toBe('archived');
    await fails(tx((t) => createBranch(t, owner, { cityId: msk.id, slug: 'new', name: 'N', address: 'a' }, meta(owner), clock)), 'CITY_ARCHIVED');
    await expect(pool.query('DELETE FROM app.branches WHERE id = $1', [arbat.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('смена зоны не сдвигает прошлые события; график остаётся «10:00» по новой зоне', async () => {
    const before = await db.client.query(`SELECT created_at, temp_closed_from FROM app.branches WHERE id = $1`, [akadem.id]);
    const auditBefore = await db.client.query(`SELECT id, occurred_at FROM journal.audit_events WHERE object_id = $1 ORDER BY occurred_at, id`, [akadem.id]);
    const r = await tx((t) => changeBranchTimezone(t, owner, akadem.id, { rowVersion: akadem.rowVersion, timezone: 'Asia/Omsk' }, meta(owner), clock));
    expect(r.branch.timezone).toBe('Asia/Omsk');
    expect(r.affectedBookingIds).toEqual([]);
    const after = await db.client.query(`SELECT created_at, temp_closed_from FROM app.branches WHERE id = $1`, [akadem.id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const auditAfter = await db.client.query(
      `SELECT id, occurred_at FROM journal.audit_events WHERE object_id = $1 AND action <> 'branch.updated' ORDER BY occurred_at, id`,
      [akadem.id],
    );
    expect(auditAfter.rows).toEqual(auditBefore.rows);
    expect(await openIntervals(pool, { branchId: akadem.id, date: '2026-12-01' as LocalDate })).toEqual([
      { start: new Date('2026-12-01T04:00:00Z'), end: new Date('2026-12-01T16:00:00Z') },
    ]);
    const a = await db.client.query(`SELECT before, after FROM journal.audit_events WHERE action = 'branch.updated' AND object_id = $1`, [akadem.id]);
    expect(a.rows[0]).toMatchObject({ before: { timezone: 'Asia/Novosibirsk' }, after: { timezone: 'Asia/Omsk' } });
  });

  it('город: изменение с версией и аудитом только изменённых полей', async () => {
    const c = await tx((t) => updateCity(t, owner, nsk.id, { rowVersion: 1, region: 'Новосибирская область' }, meta(owner), clock));
    expect(c).toMatchObject({ region: 'Новосибирская область', rowVersion: 2 });
    const a = await db.client.query(`SELECT after FROM journal.audit_events WHERE action = 'city.updated' AND object_id = $1`, [nsk.id]);
    expect(a.rows[0].after).toEqual({ region: 'Новосибирская область' });
  });
});

describe('списки по зоне и курсору', () => {
  it('Владелец: все неархивные, порциями по курсору; с includeArchived – и архивные', async () => {
    const p1 = await listBranches(pool, owner, { limit: '1' });
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listBranches(pool, owner, { limit: '1', cursor: p1.nextCursor });
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].map((b) => b.slug)).toEqual(['akadem', 'krasny']);
    const all = await listBranches(pool, owner, { includeArchived: 'true' });
    expect(all.items.map((b) => b.slug)).toEqual(['arbat', 'akadem', 'hours', 'krasny']);
  });

  it('Администратор видит только свой филиал и свой город; мусорный курсор – VALIDATION_FAILED', async () => {
    const admin = ctx('admin', { branchIds: [krasny.id] });
    expect((await listBranches(pool, admin, {})).items.map((b) => b.id)).toEqual([krasny.id]);
    expect((await listCities(pool, admin, {})).items.map((c) => c.id)).toEqual([nsk.id]);
    await fails(getCity(pool, admin, msk.id), 'NOT_FOUND');
    expect((await getCity(pool, admin, nsk.id)).slug).toBe('nsk');
    await fails(listBranches(pool, admin, { cursor: 'мусор' }), 'VALIDATION_FAILED');
  });
});
