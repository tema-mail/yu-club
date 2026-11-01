// Фикстуры сети для тестов: город и филиал с заданным id (назначения, счета и проводки ссылаются на них FK, 0011).
// Повторный вызов с тем же id ничего не меняет. Через SQL владельцем объектов, без команд и аудита модуля network.
import { randomBytes } from 'node:crypto';

interface Q {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const suffix = () => randomBytes(4).toString('hex');

/** Город с id (или случайным). Возвращает id. */
export async function createTestCity(db: Q, opts: { id?: string; timezone?: string } = {}): Promise<string> {
  const slug = `t-${suffix()}`;
  const r = (await db.query(
    `INSERT INTO app.cities (id, code, slug, name, timezone) VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $2, $2, $3)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING id`,
    [opts.id ?? null, slug, opts.timezone ?? 'Asia/Novosibirsk'],
  )) as { rows: Array<{ id: string }> };
  return r.rows[0]!.id;
}

/** Филиал с id (или случайным) в городе cityId; города нет – создаётся (с cityId, если задан). */
export async function createTestBranch(
  db: Q,
  opts: { id?: string; cityId?: string; timezone?: string; status?: string } = {},
): Promise<{ id: string; cityId: string }> {
  const tz = opts.timezone ?? 'Asia/Novosibirsk';
  const cityId = await createTestCity(db, { ...(opts.cityId ? { id: opts.cityId } : {}), timezone: tz });
  const slug = `t-${suffix()}`;
  const r = (await db.query(
    `INSERT INTO app.branches (id, city_id, code, slug, name, address, timezone, status)
     VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $3, $3, 'тестовый адрес', $4, $5)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING id, city_id`,
    [opts.id ?? null, cityId, slug, tz, opts.status ?? 'active'],
  )) as { rows: Array<{ id: string; city_id: string }> };
  return { id: r.rows[0]!.id, cityId: r.rows[0]!.city_id };
}
