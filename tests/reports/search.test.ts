// S4-75: глобальный поиск (K24 §5, K11 №250). Клиент вне зоны не находится по точному телефону; тип без права отсутствует в ответе;
// поиск по телефону – в аудите маской; короткая строка – ошибка; ≤ 2 с проверяет tests/reports/perf.test.ts на объёме сети.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { recordIncome } from '../../apps/api/src/modules/finance/cashbox.ts';
import { globalSearch, type SearchGroup } from '../../apps/api/src/modules/reports/search.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { reportFixtures, type Fx } from '../helpers/reports.ts';

const clock = fixedClock('2026-11-20T05:00:00Z');
let db: TestDatabase;
let fx: Fx;
let a: string;
let b: string;
const c: Record<string, string> = {};
const phoneB = '+79139990001';
const num: Record<string, number> = {};

const meta = (o: AccessContext): AuditRequestMeta => ({ actor: o.actor, access: o, source: 'crm', requestId: randomUUID() });
const search = (who: AccessContext, q: unknown) => globalSearch({ pool: fx.app, clock }, who, meta(who), q);
const group = (r: { groups: SearchGroup[] }, type: SearchGroup['type']) => r.groups.find((g) => g.type === type);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  a = (await fx.branch('Asia/Novosibirsk')).id;
  b = (await fx.branch('Europe/Moscow')).id;
  const ra = await fx.resource(a, 'pc', 'ПК-А', []);
  const rb = await fx.resource(b, 'pc', 'ПК-Б', []);
  c.ivan = await fx.client({ firstName: 'Иван', lastName: 'Зоновой' });
  c.other = (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, first_name, last_name, status, created_by_type, registered_at) VALUES ($1, 'Пётр', 'Чужой', 'active', 'system', now()) RETURNING id`, [phoneB])).rows[0]!.id;
  await db.client.query(`SELECT setval('app.booking_number_seq', 1000)`); // номер из одной цифры – слишком короткий запрос
  const inA = await fx.booking({ branchId: a, clientId: c.ivan, resourceId: ra, start: '2026-11-10T05:00:00Z' });
  const inB = await fx.booking({ branchId: b, clientId: c.other, resourceId: rb, start: '2026-11-10T05:00:00Z' });
  num.a = Number((await db.client.query(`SELECT number FROM app.bookings WHERE id = $1`, [inA])).rows[0].number);
  num.b = Number((await db.client.query(`SELECT number FROM app.bookings WHERE id = $1`, [inB])).rows[0].number);
  for (let i = 0; i < 7; i++) await fx.client({ firstName: 'Массовый', lastName: `Ммм${i}` });
  const o = fx.owner(clock.now());
  const conn = await fx.app.connect();
  try {
    await conn.query('BEGIN');
    await recordIncome(conn, o, { branchId: b, method: 'cash', amountKop: 100, source: 'other', occurredAt: '2026-11-15T05:00:00Z', comment: 'Уникальный_комментарий чужого филиала' }, meta(o), { idempotencyKey: randomUUID(), clock });
    await conn.query('COMMIT');
  } finally {
    conn.release();
  }
  const staff = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Сергей', 'Администратов', 'sa@yu.test', 'admin', 'x') RETURNING id`);
  await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [staff.rows[0]!.id, a]);
  await db.client.query(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Сергей', 'Чужаков', 'sc@yu.test', 'admin', 'x')`);
}, 60_000);
afterAll(async () => {
  await fx.close();
  await db.drop();
});

describe('поиск (S4-75)', () => {
  it('клиент вне зоны не находится по точному телефону; Владелец – находит; Директор зоны – только своих', async () => {
    const dir = fx.director([a]);
    expect(group(await search(dir, phoneB), 'client')!.items).toEqual([]);
    expect(group(await search(fx.owner(), phoneB), 'client')!.items).toEqual([expect.objectContaining({ id: c.other })]);
    const nameOther = await search(dir, 'Чужой');
    expect(group(nameOther, 'client')!.items).toEqual([]);
    expect(JSON.stringify(nameOther)).not.toContain(c.other!);
    expect(group(await search(dir, 'Зоновой'), 'client')!.items).toEqual([expect.objectContaining({ id: c.ivan, name: 'Иван Зоновой' })]);
  });

  it('тип без права отсутствует в ответе: Администратору нет кассы и сотрудников; Директору – есть', async () => {
    const adm = await search(fx.admin([a]), 'Зоновой');
    expect(adm.groups.map((g) => g.type)).toEqual(['client', 'booking']);
    const dir = await search(fx.director([a]), 'Зоновой');
    expect(dir.groups.map((g) => g.type)).toEqual(['client', 'booking', 'finance_operation', 'staff']);
  });

  it('маска без client.view.full; бронь по номеру – только своя зона; по клиенту и дате', async () => {
    const adm = fx.admin([a]);
    const r = await search(adm, 'Зоновой');
    expect(group(r, 'client')!.items[0]).toMatchObject({ name: 'Иван З.', kind: 'profile' });
    expect(String(group(r, 'client')!.items[0]!.phone)).toContain('•');
    expect(group(r, 'booking')!.items).toEqual([expect.objectContaining({ number: num.a, branchId: a, resourceName: 'ПК-А' })]);
    expect(group(await search(adm, String(num.a)), 'booking')!.items).toHaveLength(1);
    expect(group(await search(adm, String(num.b)), 'booking')!.items).toEqual([]);
    expect(group(await search(fx.owner(), String(num.b)), 'booking')!.items).toEqual([expect.objectContaining({ number: num.b })]);
    expect(group(await search(adm, '2026-11-10'), 'booking')!.items.map((x) => x.number)).toEqual([num.a]);
    expect(group(await search(adm, '10.11'), 'booking')!.items.map((x) => x.number)).toEqual([num.a]);
  });

  it('касса: комментарий и номер – только своя зона; сотрудник – только своя зона; лимит группы и more', async () => {
    expect(group(await search(fx.owner(), 'уникальный_комм'), 'finance_operation')!.items).toHaveLength(1);
    expect(group(await search(fx.director([a]), 'уникальный_комм'), 'finance_operation')!.items).toEqual([]);
    expect(group(await search(fx.owner(), 'Сергей'), 'staff')!.items).toHaveLength(2);
    expect(group(await search(fx.director([a]), 'Сергей'), 'staff')!.items).toEqual([expect.objectContaining({ name: 'Сергей Администратов' })]);
    const many = group(await search(fx.owner(), 'Массовый'), 'client')!;
    expect(many.items).toHaveLength(5);
    expect(many.more).toBe(true);
  });

  it('короткая строка – SEARCH_QUERY_TOO_SHORT; поиск по телефону – в аудите маской, по имени – нет', async () => {
    for (const q of ['', 'я', undefined, 42]) await expect(search(fx.owner(), q)).rejects.toMatchObject({ code: 'SEARCH_QUERY_TOO_SHORT', httpStatus: 422 });
    await expect(search(fx.owner(), '+7 9')).rejects.toMatchObject({ code: 'SEARCH_QUERY_TOO_SHORT' });
    const before = (await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'client.searched'`)).rows[0].n;
    await search(fx.owner(), 'Зоновой');
    expect((await db.client.query(`SELECT count(*)::int AS n FROM journal.audit_events WHERE action = 'client.searched'`)).rows[0].n).toBe(before);
    await search(fx.owner(), phoneB);
    const row = (await db.client.query(`SELECT * FROM journal.audit_events WHERE action = 'client.searched' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(JSON.stringify(row)).not.toContain(phoneB);
    expect(JSON.stringify(row)).toContain('+7******0001');
  });
});
