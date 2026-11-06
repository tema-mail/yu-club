// Права таблиц 0305, 0308, 0309 под рабочей ролью yu_app (ADR 0001): строки только добавляются и правятся, удаления нет – факт живёт статусом.
// Хелпер создаёт роль NOLOGIN, поэтому подключение админское, а команды идут после SET ROLE. Запросы WHERE false: права проверяются при
// разборе запроса, а строк и внешних ключей они не касаются. 42501 – отказ по правам, не «нет строк».
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const FACT_TABLES = ['event_types', 'event_packages', 'events', 'event_lines', 'event_checklist', 'event_resources', 'holiday_dates', 'birthday_gifts', 'gift_uses'];

let db: TestDatabase;
let role: pg.Client;
const denied = (sql: string) => expect(role.query(sql)).rejects.toMatchObject({ code: '42501' });

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  role = new pg.Client({ connectionString: db.url });
  await role.connect();
  await role.query('SET ROLE yu_app');
});
afterAll(async () => {
  await role.end();
  await db.drop();
});

describe('yu_app: права таблиц мероприятий, календаря и подарка', () => {
  it('подключение действительно под yu_app', async () => {
    expect((await role.query('SELECT current_user AS u')).rows[0].u).toBe('yu_app');
  });
  it.each(FACT_TABLES)('%s: чтение, вставка и правка есть; DELETE и TRUNCATE – 42501', async (table) => {
    await role.query(`SELECT 1 FROM app.${table} WHERE false`);
    await role.query(`INSERT INTO app.${table} SELECT * FROM app.${table} WHERE false`);
    await role.query(`UPDATE app.${table} SET id = id WHERE false`);
    await denied(`DELETE FROM app.${table} WHERE false`);
    await denied(`TRUNCATE app.${table}`);
  });
  it('event_bookings: связь – ссылка: вставка и удаление есть, UPDATE и TRUNCATE – 42501', async () => {
    await role.query('SELECT 1 FROM app.event_bookings WHERE false');
    await role.query('INSERT INTO app.event_bookings SELECT * FROM app.event_bookings WHERE false');
    await role.query('DELETE FROM app.event_bookings WHERE false');
    await denied('UPDATE app.event_bookings SET linked_at = linked_at WHERE false');
    await denied('TRUNCATE app.event_bookings');
  });
  it('последовательности номеров EV- и подарка доступны', async () => {
    expect(Number((await role.query(`SELECT nextval('app.event_number_seq') AS n`)).rows[0].n)).toBeGreaterThan(0);
    expect(Number((await role.query(`SELECT nextval('app.gift_number_seq') AS n`)).rows[0].n)).toBeGreaterThan(0);
  });
  it('служебный тип gift_vr есть и защищён: удаление запрещено', async () => {
    expect((await role.query(`SELECT is_system FROM app.dict_resource_types WHERE code = 'gift_vr'`)).rows[0].is_system).toBe(true);
    await denied(`DELETE FROM app.dict_resource_types WHERE code = 'gift_vr'`);
  });
});
