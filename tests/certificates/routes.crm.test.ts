// S2-53 по HTTP: K16 §11 №29–36. IDOR – 404 с телом несуществующего; Администратор не продаёт (08 §4.1) и не
// корректирует; код – только в первом ответе продажи, не в логе и не в idempotency_keys; 5 неверных кодов →
// CERTIFICATE_PIN_LOCKED.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { hashPassword, staffAuthConfig } from '../../apps/api/src/modules/staff/auth.ts';
import { buildServer } from '../../apps/api/src/server.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const PASSWORD = 'Пароль-сертификатов-1';
const PEPPER = 'cert-pepper-'.padEnd(40, 'r');
const BASE = '/api/crm/v1';
let db: TestDatabase;
let pool: pg.Pool;
let app: FastifyInstance;
let log = '';
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const clock = fixedClock('2026-11-14T05:00:00Z');

async function staff(key: string, role: string, branch?: string): Promise<void> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', $1, $2, $3) RETURNING id`,
    [`${key}@yu.test`, role, await hashPassword(PASSWORD)],
  );
  ids[key] = r.rows[0]!.id;
  if (branch) {
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [
      r.rows[0]!.id,
      branch,
    ]);
  }
  const res = await app.inject({ method: 'POST', url: `${BASE}/auth/login`, payload: { email: `${key}@yu.test`, password: PASSWORD } });
  cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
}
function req(who: string, method: 'GET' | 'POST', url: string, payload?: object, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (key && method !== 'GET') headers['idempotency-key'] = key;
  return app.inject({ method, url: `${BASE}${url}`, headers, ...(payload ? { payload } : {}) });
}
const errBody = (b: { error: Record<string, unknown> }) => ({ ...b.error, requestId: undefined });
const sell = (who = 'owner', branch = ids.lenina!, payload: object = { nominalKop: 300_000, method: 'cash' }, key?: string) =>
  req(who, 'POST', `/branches/${branch}/certificates`, payload, key ?? randomUUID());

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 6 });
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      log += String(chunk);
      cb();
    },
  });
  app = buildServer(loadConfig({ LOG_LEVEL: 'trace' }), { staff: { pool, auth: staffAuthConfig('t'.repeat(40)), clock }, certificates: { pepper: PEPPER }, logStream });
  await staff('owner', 'owner');
  const c = await req('owner', 'POST', '/cities', { slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk' });
  for (const slug of ['lenina', 'marksa']) {
    const b = await req('owner', 'POST', '/branches', { cityId: c.json().id, slug, name: slug, address: 'адрес' });
    ids[slug] = b.json().id;
  }
  await staff('director', 'director', ids.lenina);
  await staff('admin', 'admin', ids.lenina);
  await staff('director2', 'director', ids.marksa);
  await staff('admin2', 'admin', ids.marksa);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.drop();
});

describe('продажа №31', () => {
  it('Владелец и Директор – 201 с кодом; повтор ключа – тот же сертификат без кода; кода нет в логе и idempotency_keys', async () => {
    const key = randomUUID();
    const first = await sell('director', ids.lenina, { nominalKop: 500_000, method: 'card', comment: 'подарок' }, key);
    expect(first.statusCode).toBe(201);
    const { certificate, pin } = first.json();
    expect(pin).toMatch(/^\d{4}$/);
    expect(certificate).toMatchObject({ nominalKop: 500_000, balanceKop: 500_000, status: 'active', saleBranchId: ids.lenina });
    const again = await sell('director', ids.lenina, { nominalKop: 500_000, method: 'card', comment: 'подарок' }, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual({ certificate, pin: null, pinShownOnce: true });
    expect(log).toContain('/certificates'); // лог запросов пишется – и кода в нём нет
    expect(log).not.toMatch(new RegExp(`"pin"\\s*:\\s*"${pin}"`));
    const k = await db.client.query<{ t: string }>(`SELECT row_to_json(k)::text AS t FROM app.idempotency_keys k WHERE key = $1`, [key]);
    expect(k.rows[0]!.t).not.toMatch(new RegExp(`"pin"\\s*:\\s*"${pin}"`));
  });

  it('Администратор – 403 и отказ в аудите; чужой филиал и несуществующий – одинаковый 404; номинал 0 – 422', async () => {
    const adm = await sell('admin');
    expect(adm.statusCode).toBe(403);
    const denied = await db.client.query(`SELECT action, result FROM journal.audit_events WHERE actor_id = $1 AND result = 'denied'`, [ids.admin]);
    expect(denied.rows).toEqual([{ action: 'certificate.sold', result: 'denied' }]);
    const foreign = await sell('director2', ids.lenina);
    const missing = await sell('director2', randomUUID());
    expect(foreign.statusCode).toBe(404);
    expect(errBody(foreign.json())).toEqual(errBody(missing.json()));
    const zero = await sell('owner', ids.lenina, { nominalKop: 0, method: 'cash' });
    expect([zero.statusCode, zero.json().error.code]).toEqual([422, 'NOMINAL_OUT_OF_RANGE']);
    expect((await sell('owner', ids.lenina, { nominalKop: 100 })).statusCode).toBe(400); // без способа
  });
});

describe('список №29 и карточка №30', () => {
  it('Директор видит свою зону; поиск по номеру; карточка с движением; чужая карточка – 404 как несуществующая', async () => {
    const s = (await sell('owner', ids.marksa, { nominalKop: 120_000, method: 'transfer' })).json().certificate;
    const mine = await req('director2', 'GET', '/certificates');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.map((x: { saleBranchId: string }) => x.saleBranchId)).toEqual([ids.marksa]);
    const found = await req('owner', 'GET', `/certificates?q=${encodeURIComponent(s.number.slice(3, 9).toLowerCase())}`);
    expect(found.json().items.map((x: { id: string }) => x.id)).toEqual([s.id]);
    const active = await req('owner', 'GET', `/certificates?status=active&branchId=${ids.marksa}`);
    expect(active.json().items).toHaveLength(1);
    expect((await req('owner', 'GET', '/certificates?expiring=7')).json().items).toEqual([]);
    const card = await req('admin2', 'GET', `/certificates/${s.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ id: s.id, redemptions: [], history: [], timeline: [{ type: 'sale', amountKop: 120_000, balanceAfterKop: 120_000 }] });
    expect(JSON.stringify(card.json())).not.toMatch(/pin/i);
    const foreign = await req('director', 'GET', `/certificates/${s.id}`);
    const missing = await req('director', 'GET', `/certificates/${randomUUID()}`);
    expect(foreign.statusCode).toBe(404);
    expect(errBody(foreign.json())).toEqual(errBody(missing.json()));
  });
});

describe('команды карточки №32–35', () => {
  it('отмена Директором; Администратор не отменяет и не корректирует; чужая зона – 404', async () => {
    const a = (await sell()).json().certificate;
    const sold = (await sell()).json();
    const b = sold.certificate;
    const bPin = sold.pin as string;
    expect((await req('admin', 'POST', `/certificates/${a.id}/cancel`, { rowVersion: 1, reason: 'x', refundMoney: false })).statusCode).toBe(403);
    expect((await req('admin', 'POST', `/certificates/${a.id}/correct`, { rowVersion: 1, deltaKop: -100, reason: 'x' })).statusCode).toBe(403);
    expect((await req('director', 'POST', `/certificates/${a.id}/correct`, { rowVersion: 1, deltaKop: -100, reason: 'x' })).statusCode).toBe(403);
    for (const [path, body] of [
      ['cancel', { rowVersion: 1, reason: 'x', refundMoney: false }],
      ['correct', { rowVersion: 1, deltaKop: -100, reason: 'x' }],
      ['review', { rowVersion: 1, on: true, reason: 'x' }],
      ['recipient', { rowVersion: 1, clientId: null }],
    ] as const) {
      const r = await req('director2', 'POST', `/certificates/${a.id}/${path}`, body);
      expect(r.statusCode, path).toBe(404);
    }
    const cancelled = await req('director', 'POST', `/certificates/${a.id}/cancel`, { rowVersion: 1, reason: 'ошибка продажи', refundMoney: true });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', balanceKop: 0 });
    const corrected = await req('owner', 'POST', `/certificates/${b.id}/correct`, { rowVersion: 1, deltaKop: 1, reason: 'x' });
    expect([corrected.statusCode, corrected.json().error.code]).toEqual([422, 'CORRECTION_EXCEEDS_NOMINAL']);
    const review = await req('director', 'POST', `/certificates/${b.id}/review`, { rowVersion: 1, on: true, reason: 'проверка' });
    expect(review.json().status).toBe('needs_review');
    const stale = await req('owner', 'POST', `/certificates/${b.id}/review`, { rowVersion: 1, on: false, reason: 'ок' });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'VERSION_CONFLICT']);
    const client = (await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ('+79131112233', 'active', 'system') RETURNING id`)).rows[0].id;
    expect((await req('admin2', 'POST', `/certificates/${b.id}/recipient`, { rowVersion: 2, clientId: client })).statusCode).toBe(404);
    const byCode = (pin: string) => req('admin2', 'POST', '/certificates/recipient-by-code', { branchId: ids.marksa, number: b.number, pin, clientId: client });
    const wrong = await byCode(String((Number(bPin) + 1) % 10_000).padStart(4, '0'));
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([404, 'CERTIFICATE_NOT_FOUND']);
    const linked = await byCode(bPin);
    expect([linked.statusCode, linked.json().recipientClientId]).toEqual([200, client]);
  });
});

describe('проверка по коду №36', () => {
  it('верный код – статус и остаток; 4 неверных – 404, 5-й – 429 CERTIFICATE_PIN_LOCKED с Retry-After', async () => {
    const { certificate, pin } = (await sell('owner', ids.lenina, { nominalKop: 70_000, method: 'cash' })).json();
    const check = (p: string, who = 'admin2') => req(who, 'POST', '/certificates/check', { branchId: ids.marksa, number: certificate.number, pin: p });
    const ok = await check(pin);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ number: certificate.number, status: 'active', balanceKop: 70_000, expiresOn: certificate.expiresOn });
    expect((await check(pin, 'admin')).statusCode).toBe(404); // филиал предъявления вне зоны сотрудника
    const bad = String((Number(pin) + 1) % 10_000).padStart(4, '0');
    for (let i = 0; i < 4; i++) {
      const r = await check(bad);
      expect([r.statusCode, r.json().error.code]).toEqual([404, 'CERTIFICATE_NOT_FOUND']);
    }
    const lockedRes = await check(bad);
    expect([lockedRes.statusCode, lockedRes.json().error.code]).toEqual([429, 'CERTIFICATE_PIN_LOCKED']);
    expect(lockedRes.headers['retry-after']).toBe('900');
    expect((await check(pin)).statusCode).toBe(429);
    const unknown = await req('admin2', 'POST', '/certificates/check', { branchId: ids.marksa, number: 'YC-ZZZZ-ZZZZ', pin });
    expect(errBody(unknown.json())).toEqual({ code: 'CERTIFICATE_NOT_FOUND', message: 'Сертификат не найден или код неверен', requestId: undefined });
  });
});

describe('перевыпуск кода (K16 §3)', () => {
  it('Владелец – новый код один раз, повтор ключа – без кода; Директор и Администратор – 403; новый код проходит проверку', async () => {
    const { certificate } = (await sell('owner', ids.marksa, { nominalKop: 50_000, method: 'cash' })).json();
    expect((await req('director2', 'POST', `/certificates/${certificate.id}/pin`, { rowVersion: 1, reason: 'потерян' })).statusCode).toBe(403);
    expect((await req('admin2', 'POST', `/certificates/${certificate.id}/pin`, { rowVersion: 1, reason: 'потерян' })).statusCode).toBe(403);
    const key = randomUUID();
    const first = await req('owner', 'POST', `/certificates/${certificate.id}/pin`, { rowVersion: 1, reason: 'потерян' }, key);
    expect(first.statusCode).toBe(200);
    const pin = first.json().pin as string;
    expect(pin).toMatch(/^\d{4}$/);
    const again = await req('owner', 'POST', `/certificates/${certificate.id}/pin`, { rowVersion: 1, reason: 'потерян' }, key);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual({ certificate: first.json().certificate, pin: null, pinShownOnce: true });
    const k = await db.client.query<{ t: string }>(`SELECT row_to_json(k)::text AS t FROM app.idempotency_keys k WHERE key = $1`, [key]);
    expect(k.rows[0]!.t).not.toMatch(new RegExp(`"pin"\\s*:\\s*"${pin}"`));
    const check = await req('admin2', 'POST', '/certificates/check', { branchId: ids.marksa, number: certificate.number, pin });
    expect([check.statusCode, check.json().balanceKop]).toEqual([200, 50_000]);
  });
});
