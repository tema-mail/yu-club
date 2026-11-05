// Фикстура брони для тестов уведомлений: настоящая строка app.bookings, на которую ссылается FK notifications.booking_id (0412).
// Через SQL владельцем объектов, без команд и событий модуля booking. Ресурс один на филиал создаётся при первом обращении.
// Период у каждой брони свой – занятость (occupancy) фикстура не трогает.

interface Q {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

let seq = 0;

/** Настоящая бронь клиента в филиале. Возвращает id. status – как в CHECK 0109; отменённая получает cancelled_at. */
export async function createTestBooking(db: Q, opts: { clientId: string; branchId: string; status?: string }): Promise<string> {
  const found = (await db.query(`SELECT id FROM app.resources WHERE branch_id = $1 AND name = 'тестовый ПК' LIMIT 1`, [opts.branchId])) as { rows: Array<{ id: string }> };
  const resourceId =
    found.rows[0]?.id ??
    ((await db.query(`INSERT INTO app.resources (branch_id, resource_type, name) VALUES ($1, 'pc', 'тестовый ПК') RETURNING id`, [opts.branchId])) as { rows: Array<{ id: string }> }).rows[0]!.id;
  const start = new Date(Date.UTC(2027, 0, 1) + ++seq * 3_600_000);
  const status = opts.status ?? 'confirmed';
  const r = (await db.query(
    `INSERT INTO app.bookings (checkout_id, branch_id, client_id, status, resource_id, period, price_kop, source, created_by_type, cancelled_at, cancel_comment)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), 0, 'crm', 'system',
             CASE WHEN $3 LIKE 'cancelled%' THEN $5::timestamptz END, CASE WHEN $3 = 'cancelled_by_club' THEN 'тест' END)
     RETURNING id`,
    [opts.branchId, opts.clientId, status, resourceId, start, new Date(start.getTime() + 3_600_000)],
  )) as { rows: Array<{ id: string }> };
  return r.rows[0]!.id;
}
