// Слияние дублей (03 §11.2, K9 «Слияние», миграция 0447): объединённая карточка в базе, карточке CRM и поиске.
// База: статус merged, merged_into_id обязателен ровно у merged, телефон у merged может быть NULL (освобождается),
// journal.client_merges – только вставка у yu_app. Поиск CRM: по старым контактам не находит (они пустые),
// по id – находит с фактом объединения; в общем списке merged нет. Запись merged клиенту закрыта (CLIENT_RESTRICTED).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { assertCanBook, CLIENT_STATUSES, getClientCard, searchClients, withTx } from '../../apps/api/src/modules/clients/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF = 'cccccccc-0000-4000-8000-00000000000c';
const clock = fixedClock('2026-11-20T07:00:00Z');
const owner: AccessContext = { actor: { kind: 'staff', staffId: STAFF, sessionId: STAFF }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at: clock.now() };

let db: TestDatabase;
let pool: pg.Pool;
let seq = 79160000000;

async function addClient(name: string): Promise<{ id: string; phone: string }> {
  const phone = `+${++seq}`;
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.clients (phone_e164, first_name, last_name, email, status, registered_at, created_by_type)
     VALUES ($1, $2, 'Дублёва', $3, 'active', now(), 'system') RETURNING id`,
    [phone, name, `${name.toLowerCase()}${seq}@yu.test`],
  );
  return { id: r.rows[0]!.id, phone };
}

/** Объединённая карточка «руками» владельца базы – как её оставляет процедура K9. */
async function markMerged(secondary: string, primary: string): Promise<void> {
  await db.client.query(
    `UPDATE app.clients SET phone_e164 = NULL, phone_verified_at = NULL, first_name = NULL, last_name = NULL, email = NULL, birth_date = NULL,
       status = 'merged', merged_into_id = $2 WHERE id = $1`,
    [secondary, primary],
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('миграция 0447', () => {
  it('статус merged есть в списке и в CHECK; merged_into_id ровно у merged; телефон у merged может быть NULL', async () => {
    expect(CLIENT_STATUSES).toContain('merged');
    const a = await addClient('Анна');
    const b = await addClient('Аня');
    await expect(markMerged(b.id, a.id)).resolves.toBeUndefined();
    // merged без ссылки на основную – нельзя; ссылка без статуса – нельзя
    await expect(db.client.query(`UPDATE app.clients SET merged_into_id = NULL WHERE id = $1`, [b.id])).rejects.toThrow(/merged/);
    await expect(db.client.query(`UPDATE app.clients SET merged_into_id = $2 WHERE id = $1`, [a.id, b.id])).rejects.toThrow(/merged/);
    // активная карточка без телефона – по-прежнему нельзя
    await expect(db.client.query(`UPDATE app.clients SET phone_e164 = NULL WHERE id = $1`, [a.id])).rejects.toThrow(/phone/);
    // телефон второй карточки свободен для новой
    await db.client.query(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'guest', 'system')`, [b.phone]);
  });

  it('journal.client_merges: вставка есть, UPDATE/DELETE/TRUNCATE у yu_app отозваны', async () => {
    const a = await addClient('Вера');
    const b = await addClient('Вероника');
    await markMerged(b.id, a.id);
    await pool.query(
      `INSERT INTO journal.client_merges (primary_client_id, secondary_client_id, reason, staff_id, merged_at, results)
       VALUES ($1, $2, 'same_person_confirmed', $3, $4, '{"booking":{"bookings":1}}')`,
      [a.id, b.id, STAFF, clock.now()],
    );
    for (const sql of [
      `UPDATE journal.client_merges SET reason = 'phone_changed' WHERE secondary_client_id = '${b.id}'`,
      `DELETE FROM journal.client_merges WHERE secondary_client_id = '${b.id}'`,
      'TRUNCATE journal.client_merges',
    ]) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    // вторая карточка объединяется один раз
    await expect(
      pool.query(`INSERT INTO journal.client_merges (primary_client_id, secondary_client_id, reason, staff_id, merged_at, results) VALUES ($1, $2, 'phone_changed', $3, $4, '{}')`, [a.id, b.id, STAFF, clock.now()]),
    ).rejects.toMatchObject({ code: '23505' });
    expect((await db.client.query('SELECT * FROM journal.append_only_violations()')).rows).toEqual([]);
  });
});

describe('карточка и поиск', () => {
  it('GET карточки merged – 200 с фактом объединения и без ПДн; у живой карточки mergedIntoId = null', async () => {
    const a = await addClient('Галина');
    const b = await addClient('Галя');
    await markMerged(b.id, a.id);
    const card = await getClientCard(pool, owner, b.id);
    expect(card).toMatchObject({ id: b.id, status: 'merged', mergedIntoId: a.id, firstName: null, lastName: null, phoneMasked: '' });
    expect(card.full).toMatchObject({ phoneE164: null, email: null });
    expect((await getClientCard(pool, owner, a.id)).mergedIntoId).toBeNull();
  });

  it('поиск: по старым контактам и имени не находит, по id – находит; в общем списке нет, по фильтру статуса – есть', async () => {
    const a = await addClient('Дарья');
    const b = await addClient('Даша');
    const oldPhone = b.phone;
    await markMerged(b.id, a.id);
    const ids = async (q: { text: string; status?: Array<'merged' | 'active'> }) => (await searchClients(pool, owner, q)).items.map((i) => i.id);
    expect(await ids({ text: oldPhone })).toEqual([]);
    expect(await ids({ text: 'Даша' })).toEqual([]);
    expect(await ids({ text: b.id })).toEqual([b.id]);
    expect((await searchClients(pool, owner, { text: b.id })).items[0]).toMatchObject({ status: 'merged' });
    expect(await ids({ text: '' })).not.toContain(b.id);
    expect(await ids({ text: '', status: ['merged'] })).toContain(b.id);
  });

  it('merged клиенту бронировать нельзя – CLIENT_RESTRICTED', async () => {
    const a = await addClient('Елена');
    const b = await addClient('Лена');
    await markMerged(b.id, a.id);
    await expect(withTx(pool, (tx) => assertCanBook(tx, b.id, clock.now()))).rejects.toMatchObject({ code: 'CLIENT_RESTRICTED', details: { status: 'merged' } });
  });
});
