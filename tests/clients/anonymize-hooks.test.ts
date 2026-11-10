// K9 «Обезличивание» с настоящими обработчиками модулей (booking, events, notifications): живые записи мешают,
// ПДн мероприятий затираются (K20 §14), брони и деньги остаются по id, поиск CRM и представления отчётов
// старых ПДн не отдают (K24 §6: rpt_event_customers, rpt_clients; K9 searchClients).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { bookingClientAnonymizer } from '../../apps/api/src/modules/booking/anonymize.ts';
import { anonymizeClient, clearClientAnonymizers, registerClientAnonymizer } from '../../apps/api/src/modules/clients/anonymize.ts';
import { searchClients, withTx } from '../../apps/api/src/modules/clients/index.ts';
import { ANONYMIZED_CUSTOMER_NAME, ANONYMIZED_PHONE, eventsClientAnonymizer } from '../../apps/api/src/modules/events/anonymize.ts';
import { anonymizeClientNotifications } from '../../apps/api/src/modules/notifications/campaign-runner.ts';
import { createTestBooking } from '../helpers/booking.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF = 'cccccccc-0000-4000-8000-00000000000c';
const clock = fixedClock('2026-11-20T07:00:00Z');
const meta: AuditRequestMeta = {
  actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF },
  access: { role: 'owner', network: true, cityIds: new Set(), branchIds: new Set() },
  source: 'crm',
  requestId: 'req-anonymize-hooks',
};
const owner: AccessContext = { actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };

let db: TestDatabase;
let pool: pg.Pool;
let branchId = '';
let typeId = '';
let seq = 79140000000;
let eventSeq = 0;

async function addClient(): Promise<{ id: string; phone: string }> {
  const phone = `+${++seq}`;
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, first_name, last_name, status, registered_at, created_by_type) VALUES ($1, 'Аглая', 'Пестова', 'active', now(), 'system') RETURNING id`,
    [phone],
  );
  return { id: r.rows[0]!.id, phone };
}

async function addEvent(o: { customer?: string; birthday?: string; status: string; name?: string; phone?: string }): Promise<string> {
  const final = ['cancelled', 'not_held'].includes(o.status);
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.events (number, type_id, branch_id, title, planned_start, planned_end, status, customer_client_id, customer_name, customer_phone_e164,
       birthday_client_id, birthday_person_name, wishes, source, created_by_type, cancel_reason)
     VALUES ($1, $2, $3, 'Праздник', '2026-10-01T10:00Z', '2026-10-01T13:00Z', $4, $5, $6, $7, $8, 'Тимофей', 'торт без орехов', 'crm', 'system', $9) RETURNING id`,
    [`EV-${++eventSeq}`, typeId, branchId, o.status, o.customer ?? null, o.name ?? 'Аглая Пестова', o.phone ?? '+79990001122', o.birthday ?? null, final ? 'тест' : null],
  );
  return r.rows[0]!.id;
}

const run = (clientId: string) => withTx(pool, (tx) => anonymizeClient(tx, clientId, { reason: 'client_request' }, meta, clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  branchId = (await createTestBranch(db.client)).id;
  typeId = (await db.client.query<{ id: string }>(`SELECT id FROM app.event_types WHERE code = 'birthday'`)).rows[0]!.id;
  clearClientAnonymizers();
  registerClientAnonymizer(bookingClientAnonymizer);
  registerClientAnonymizer(eventsClientAnonymizer);
  registerClientAnonymizer({ name: 'notifications', run: anonymizeClientNotifications });
});
afterAll(async () => {
  clearClientAnonymizers();
  await pool.end();
  await db.drop();
});

describe('обработчики модулей', () => {
  it('бронь впереди и мероприятие в работе мешают; прошедшие и отменённые – нет', async () => {
    const c = await addClient();
    await createTestBooking(db.client, { clientId: c.id, branchId }); // 2027 – впереди
    await createTestBooking(db.client, { clientId: c.id, branchId, status: 'cancelled_by_client' });
    await addEvent({ customer: c.id, status: 'confirmed' });
    await addEvent({ customer: c.id, status: 'cancelled' });
    await expect(run(c.id)).rejects.toMatchObject({ code: 'CLIENT_HAS_ACTIVE_RECORDS', details: { blockers: { booking: 1, events: 1 } } });
  });

  it('мероприятия: заказчик – всё затёрто заглушками; только именинник – контакт заказчика остаётся; суммы и связь по id целы', async () => {
    const c = await addClient();
    const asCustomer = await addEvent({ customer: c.id, status: 'completed', phone: c.phone });
    const asBirthday = await addEvent({ birthday: c.id, status: 'cancelled', name: 'Родитель Иванов', phone: '+79995556677' });
    const foreign = await addEvent({ status: 'completed', name: 'Чужой Заказчик' });
    const booking = await createTestBooking(db.client, { clientId: c.id, branchId, status: 'completed' });

    const res = await run(c.id);
    expect(res.affected).toEqual({ booking: 0, events: 2, notifications: 0 });

    const rows = (
      await db.client.query(
        'SELECT id, customer_client_id, birthday_client_id, customer_name, customer_phone_e164, birthday_person_name, wishes, status FROM app.events WHERE id = ANY($1::uuid[])',
        [[asCustomer, asBirthday, foreign]],
      )
    ).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[asCustomer]).toMatchObject({ customer_client_id: c.id, customer_name: ANONYMIZED_CUSTOMER_NAME, customer_phone_e164: ANONYMIZED_PHONE, birthday_person_name: null, wishes: null, status: 'completed' });
    expect(by[asBirthday]).toMatchObject({ birthday_client_id: c.id, customer_name: 'Родитель Иванов', customer_phone_e164: '+79995556677', birthday_person_name: null, wishes: null });
    expect(by[foreign]).toMatchObject({ customer_name: 'Чужой Заказчик', birthday_person_name: 'Тимофей', wishes: 'торт без орехов' });

    // бронь не тронута и по-прежнему связана с карточкой
    expect((await db.client.query('SELECT client_id, status FROM app.bookings WHERE id = $1', [booking])).rows[0]).toEqual({ client_id: c.id, status: 'completed' });

    // представление для глобального поиска (K24 §5) старых ПДн не отдаёт
    const view = (await db.client.query('SELECT customer_name, customer_phone_e164 FROM app.rpt_event_customers WHERE event_id = $1', [asCustomer])).rows[0];
    expect(view).toEqual({ customer_name: ANONYMIZED_CUSTOMER_NAME, customer_phone_e164: ANONYMIZED_PHONE });
    expect((await db.client.query('SELECT count(*)::int AS n FROM app.rpt_event_customers WHERE customer_phone_e164 = $1', [c.phone])).rows[0].n).toBe(0);
  });

  it('поиск CRM: ни по фамилии, ни по телефону, ни по 4 цифрам; явный фильтр статуса даёт строку без ПДн', async () => {
    const c = await addClient();
    await run(c.id);
    for (const q of ['Пестова', c.phone, c.phone.slice(-4)]) {
      const page = await searchClients(pool, owner, { text: q }, {});
      expect(page.items.find((x) => x.id === c.id)).toBeUndefined();
    }
    const page = await searchClients(pool, owner, { text: c.id, status: ['anonymized'] }, {});
    expect(page.items).toEqual([{ id: c.id, status: 'anonymized', firstName: null, lastName: null, phoneMasked: '', lastVisitAt: null, lastBranchId: null }]);
  });
});
