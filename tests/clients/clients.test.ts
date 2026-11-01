import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { errorStatus, registeredAuditActions } from '../../apps/api/src/core/registry.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import {
  assertCanBook,
  findOrCreateGuest,
  getClientCard,
  getNotificationPrefs,
  maskPhone,
  normalizePhone,
  searchClients,
  withTx,
  type ClientBranchLinks,
} from '../../apps/api/src/modules/clients/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const BR_1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const BR_2 = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const STAFF = 'cccccccc-0000-4000-8000-00000000000c';

let db: TestDatabase;
let pool: pg.Pool;
const clock = fixedClock('2026-11-20T07:00:00Z');
const meta: AuditRequestMeta = {
  actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF },
  access: { role: 'admin', network: false, cityIds: new Set(), branchIds: new Set([BR_1]) },
  source: 'crm',
  requestId: 'req-clients',
};

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return {
    actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: clock.now(),
  };
}

// Связи клиент – филиал до модуля booking: тестовая таблица вместо броней.
const links: ClientBranchLinks = {
  existsSql: (col, param) => `EXISTS (SELECT 1 FROM app.t_links l WHERE l.client_id = ${col} AND l.branch_id = ANY(${param}))`,
};

async function addClient(phone: string | null, firstName: string | null, lastName: string | null, status = 'active'): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, first_name, last_name, status, registered_at, created_by_type)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'guest' THEN NULL ELSE now() END, 'system') RETURNING id`,
    [phone, firstName, lastName, status],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 8 });
  await db.client.query('CREATE TABLE app.t_links (client_id uuid, branch_id uuid)');
  await db.client.query('GRANT SELECT ON app.t_links TO yu_app');
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('телефон', () => {
  it.each([
    ['+7 (913) 123-45-67', '+79131234567'],
    ['8 913 123 45 67', '+79131234567'],
    ['79131234567', '+79131234567'],
    ['9131234567', '+79131234567'],
    ['+375 29 123-45-67', '+375291234567'],
  ])('%s → %s', (input, e164) => expect(normalizePhone(input)).toBe(e164));

  it.each(['', '123', '+7 913 123', '+7913123456789', 'abc', '+0123456789', '89131234567x'])('«%s» → VALIDATION_FAILED', (input) => {
    expect(() => normalizePhone(input)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', httpStatus: 400 }));
  });

  it('маска: +7 ••• ••• ••-67, пусто у обезличенного', () => {
    expect(maskPhone('+79131234567')).toBe('+7 ••• ••• ••-67');
    expect(maskPhone(null)).toBe('');
  });
});

describe('реестры', () => {
  it('коды clients зарегистрированы', () => {
    expect(errorStatus.OTP_EXPIRED).toBe(410);
    expect(errorStatus.OTP_RATE_LIMITED).toBe(429);
    expect(errorStatus.CONSENT_REQUIRED).toBe(422);
    expect(errorStatus.CLIENT_RESTRICTED).toBe(403);
    expect(registeredAuditActions.has('client.created')).toBe(true);
    expect(registeredAuditActions.has('auth.client.login')).toBe(true);
  });
});

describe('ограничения базы (0105)', () => {
  it('телефон NULL – только у anonymized', async () => {
    await expect(addClient(null, 'А', 'Б', 'active')).rejects.toThrow(/check/i);
    await expect(addClient(null, null, null, 'anonymized')).resolves.toEqual(expect.any(String));
  });

  it('одна карточка на телефон', async () => {
    await addClient('+79990000001', 'Один', null);
    await expect(addClient('+79990000001', 'Два', null)).rejects.toThrow(/duplicate|unique/i);
  });

  it('guest без registered_at; телефон не в E.164 отвергается', async () => {
    await expect(
      db.client.query(
        `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ('+79990000002', 'guest', now(), 'system')`,
      ),
    ).rejects.toThrow(/check/i);
    await expect(addClient('89990000003', 'А', null)).rejects.toThrow(/check/i);
  });

  it('client_consents – только вставка; согласие на ПДн без версии текста отвергается', async () => {
    const v = await db.client.query('SELECT * FROM journal.append_only_violations()');
    expect(v.rows).toEqual([]);
    const id = await addClient('+79990000004', 'А', null);
    await expect(
      db.client.query(
        `INSERT INTO journal.client_consents (client_id, kind, granted, source, actor_type) VALUES ($1, 'pd_processing', true, 'site', 'client')`,
        [id],
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe('findOrCreateGuest', () => {
  it('10 параллельных вызовов с одним телефоном → одна карточка guest, один client.created', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withTx(pool, (tx) => findOrCreateGuest(tx, { phone: '8 (913) 555-00-11', firstName: `Гость${i}` }, meta, clock)),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results[0]).toMatchObject({ status: 'guest', phoneMasked: '+7 ••• ••• ••-11' });
    const rows = await db.client.query("SELECT status, registered_at FROM app.clients WHERE phone_e164 = '+79135550011'");
    expect(rows.rows).toEqual([{ status: 'guest', registered_at: null }]);
    const audit = await db.client.query(
      "SELECT after FROM journal.audit_events WHERE action = 'client.created' AND object_id = $1",
      [results[0]!.id],
    );
    expect(audit.rows).toHaveLength(1);
    // ПДн в аудите – по явному списку K2: телефон и имя маскируются.
    expect(audit.rows[0].after.phoneE164).toBe('+7******0011');
    expect(audit.rows[0].after.firstName).toMatch(/^Г\*\*\*$/);
  });

  it('существующая карточка не переписывается; пустое имя заполняется', async () => {
    const id = await addClient('+79135550022', null, 'Иванов');
    const ref = await withTx(pool, (tx) => findOrCreateGuest(tx, { phone: '9135550022', firstName: 'Пётр', lastName: 'Петров' }, meta, clock));
    expect(ref).toMatchObject({ id, status: 'active', firstName: 'Пётр', lastName: 'Иванов' });
    const again = await withTx(pool, (tx) => findOrCreateGuest(tx, { phone: '9135550022', firstName: 'Сидор' }, meta, clock));
    expect(again.firstName).toBe('Пётр');
  });

  it('пустое имя → VALIDATION_FAILED', async () => {
    await expect(withTx(pool, (tx) => findOrCreateGuest(tx, { phone: '9135550033', firstName: '  ' }, meta, clock))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('assertCanBook и настройки уведомлений', () => {
  it('guest и active – можно; blocked/restricted/deletion_requested – CLIENT_RESTRICTED', async () => {
    const ok = await addClient('+79135550044', 'А', null, 'guest');
    await expect(assertCanBook(pool, ok, clock.now())).resolves.toBeUndefined();
    for (const [i, status] of ['blocked', 'restricted', 'deletion_requested'].entries()) {
      const id = await addClient(`+7913555010${i}`, 'А', null, status);
      await expect(assertCanBook(pool, id, clock.now())).rejects.toMatchObject({ code: 'CLIENT_RESTRICTED', httpStatus: 403 });
    }
  });

  it('restricted с истёкшим сроком – можно', async () => {
    const id = await addClient('+79135550055', 'А', null, 'restricted');
    await db.client.query("UPDATE app.clients SET status_until = '2026-11-01T00:00:00Z' WHERE id = $1", [id]);
    await expect(assertCanBook(pool, id, clock.now())).resolves.toBeUndefined();
  });

  it('нет строки настроек – напоминания вкл., реклама выкл.', async () => {
    const id = await addClient('+79135550066', 'А', null);
    expect(await getNotificationPrefs(pool, id)).toEqual({ remindersEnabled: true, marketingEnabled: false });
  });
});

describe('поиск и карточка в CRM', () => {
  let ivanov: string;
  let petrova: string;
  beforeAll(async () => {
    ivanov = await addClient('+79231112233', 'Иван', 'Иванов');
    petrova = await addClient('+79234445566', 'Анна', 'Петрова');
    await db.client.query('UPDATE app.clients SET email = $2 WHERE id = $1', [petrova, 'anna@yu.test']);
    await db.client.query('INSERT INTO app.t_links VALUES ($1, $2), ($3, $4)', [ivanov, BR_1, petrova, BR_2]);
  });
  const ids = (p: { items: Array<{ id: string }> }) => p.items.map((i) => i.id);

  it('Владелец: по телефону в любом виде, последним 4 цифрам, ФИО, email, id', async () => {
    const o = ctx('owner');
    expect(ids(await searchClients(pool, o, { text: '8 (923) 111-22-33' }))).toEqual([ivanov]);
    expect(ids(await searchClients(pool, o, { text: '2233' }))).toEqual([ivanov]);
    expect(ids(await searchClients(pool, o, { text: '11122' }))).toEqual([ivanov]);
    // все слова – начала фамилии или имени: «Иван Иванов» находится, «Анна Петрова» – нет
    const byName = ids(await searchClients(pool, o, { text: 'иван ив' }));
    expect(byName).toContain(ivanov);
    expect(byName).not.toContain(petrova);
    expect(ids(await searchClients(pool, o, { text: 'Петро' }))).toEqual([petrova]);
    expect(ids(await searchClients(pool, o, { text: 'ANNA@yu.test' }))).toEqual([petrova]);
    expect(ids(await searchClients(pool, o, { text: ivanov }))).toEqual([ivanov]);
  });

  it('в выдаче телефон маскирован, полного номера нет', async () => {
    const page = await searchClients(pool, ctx('owner'), { text: '2233' });
    expect(page.items[0]).toMatchObject({ phoneMasked: '+7 ••• ••• ••-33', lastVisitAt: null, lastBranchId: null });
    expect(JSON.stringify(page)).not.toContain('1112233');
  });

  it('Администратор: свой филиал – по ФИО; чужого клиента по ФИО не находит, по точному телефону – находит', async () => {
    const a = ctx('admin', [BR_1]);
    expect(ids(await searchClients(pool, a, { text: 'Иванов' }, {}, links))).toEqual([ivanov]);
    expect(ids(await searchClients(pool, a, { text: 'Петрова' }, {}, links))).toEqual([]);
    expect(ids(await searchClients(pool, a, { text: '4445566' }, {}, links))).toEqual([]);
    expect(ids(await searchClients(pool, a, { text: '+7 923 444-55-66' }, {}, links))).toEqual([petrova]);
    // без модуля броней связи нет ни у кого
    expect(ids(await searchClients(pool, a, { text: 'Иванов' }))).toEqual([]);
  });

  it('фильтр филиала вне зоны – NOT_FOUND; без назначений – пусто', async () => {
    await expect(searchClients(pool, ctx('admin', [BR_1]), { text: '', branchId: BR_2 }, {}, links)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await searchClients(pool, ctx('admin'), { text: '+79231112233' }, {}, links)).items).toEqual([]);
  });

  it('карточка: Администратор – минимум, Директор в зоне – полная, чужой клиент – NOT_FOUND', async () => {
    const a = await getClientCard(pool, ctx('admin', [BR_1]), ivanov, links);
    expect(a).toMatchObject({ id: ivanov, firstName: 'Иван', phoneMasked: '+7 ••• ••• ••-33', full: null, isGuest: false });
    expect(JSON.stringify(a)).not.toContain('1112233');
    await expect(getClientCard(pool, ctx('admin', [BR_1]), petrova, links)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const d = await getClientCard(pool, ctx('director', [BR_2]), petrova, links);
    expect(d.full).toMatchObject({ phoneE164: '+79234445566', email: 'anna@yu.test' });
    await expect(getClientCard(pool, ctx('owner'), '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('пустой запрос – список с курсором без повторов; обезличенные скрыты', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await searchClients(pool, ctx('owner'), { text: '' }, { cursor, limit: 3 });
      seen.push(...ids(page));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const total = await db.client.query<{ n: number }>("SELECT count(*)::int AS n FROM app.clients WHERE status <> 'anonymized'");
    expect(seen.length).toBe(total.rows[0]!.n);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('кривой курсор и 3 цифры – VALIDATION_FAILED', async () => {
    await expect(searchClients(pool, ctx('owner'), { text: '' }, { cursor: 'xx' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(searchClients(pool, ctx('owner'), { text: '123' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('скорость поиска', () => {
  it('100 000 карточек: телефон, 4 цифры, ФИО, список – каждый ≤ 2 с', { timeout: 120_000 }, async () => {
    await db.client.query(`
      INSERT INTO app.clients (phone_e164, first_name, last_name, status, registered_at, created_by_type)
      SELECT '+7900' || lpad(g::text, 7, '0'),
             (ARRAY['Иван','Пётр','Анна','Мария','Олег'])[1 + g % 5],
             (ARRAY['Смирнов','Кузнецов','Попова','Соколова','Лебедев'])[1 + g % 5] || g,
             'active', now(), 'system'
      FROM generate_series(1, 100000) g`);
    await db.client.query('ANALYZE app.clients');
    const o = ctx('owner');
    for (const text of ['+79000054321', '4321', 'Смирнов12', 'анна', '']) {
      const t0 = performance.now();
      const page = await searchClients(pool, o, { text });
      const ms = performance.now() - t0;
      expect(page.items.length).toBeGreaterThan(0);
      expect(ms).toBeLessThan(2000);
    }
  });
});
