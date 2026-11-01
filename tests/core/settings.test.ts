import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSetting, resolveSettings, SETTINGS, settingDef, settingHistory } from '../../apps/api/src/core/settings.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
const ids: Record<string, string> = {};
const SYS = '00000000-0000-4000-8000-000000000000';
const T0 = new Date('2026-01-01T00:00:00Z');

async function asApp<T>(fn: () => Promise<T>): Promise<T> {
  await db.client.query('SET ROLE yu_app');
  try {
    return await fn();
  } finally {
    await db.client.query('RESET ROLE');
  }
}

async function put(key: string, level: 'network' | 'city' | 'branch', id: string | null, value: unknown, from: Date, to: Date | null = null): Promise<string> {
  const r = await db.client.query<{ id: string }>(
    `INSERT INTO app.settings_values (key, level, city_id, branch_id, value, valid_from, valid_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [key, level, level === 'city' ? id : null, level === 'branch' ? id : null, JSON.stringify(value), from, to, SYS],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  const c = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('nsk', 'nsk', 'Н', 'Asia/Novosibirsk') RETURNING id`);
  ids.nsk = c.rows[0]!.id;
  const c2 = await db.client.query<{ id: string }>(`INSERT INTO app.cities (code, slug, name, timezone) VALUES ('tsk', 'tsk', 'Т', 'Asia/Tomsk') RETURNING id`);
  ids.tsk = c2.rows[0]!.id;
  for (const [k, city] of [['b1', ids.nsk], ['b2', ids.nsk], ['b3', ids.tsk]] as const) {
    const b = await db.client.query<{ id: string }>(
      `INSERT INTO app.branches (city_id, code, slug, name, address, timezone) VALUES ($1, $2, $2, $2, 'a', 'Asia/Novosibirsk') RETURNING id`,
      [city, k],
    );
    ids[k] = b.rows[0]!.id;
  }
});
afterAll(async () => {
  await db.drop();
});

describe('реестр K7', () => {
  it('системные значения по умолчанию: окно 7/30, удержание 15, напоминание 21:00, потолок анонимных 30', () => {
    expect(SETTINGS['booking.window_default_days'].systemDefault).toBe(7);
    expect(SETTINGS['booking.window_max_days'].systemDefault).toBe(30);
    expect(SETTINGS['booking.hold_minutes'].systemDefault).toBe(15);
    expect(SETTINGS['notifications.reminder_day_before_time'].systemDefault).toBe('21:00');
    expect(SETTINGS['notifications.reminder_before_minutes'].systemDefault).toBe(15);
    expect(SETTINGS['booking.max_anonymous_holds_per_branch'].systemDefault).toBe(30);
    expect(SETTINGS['booking.max_anonymous_holds_per_branch'].levels).toEqual(['network', 'branch']);
    expect(Object.keys(SETTINGS)).toHaveLength(20);
  });

  it('системное значение каждого ключа проходит его же схему', () => {
    for (const [key, d] of Object.entries(SETTINGS)) expect(d.schema.safeParse(d.systemDefault).success, key).toBe(true);
  });

  it('неизвестный ключ – ошибка программиста', async () => {
    expect(() => settingDef('booking.nope')).toThrow(/неизвестный ключ/);
    await expect(resolveSetting(db.client, 'booking.nope' as never, { network: true }, T0)).rejects.toThrow(/неизвестный ключ/);
  });
});

describe('0009: защита в базе', () => {
  it('пересечение дат одного уровня одной области – EXCLUDE; у другого филиала – можно', async () => {
    await put('booking.buffer_minutes', 'branch', ids.b1!, 5, T0, new Date('2026-06-01T00:00:00Z'));
    await expect(put('booking.buffer_minutes', 'branch', ids.b1!, 10, new Date('2026-05-01T00:00:00Z'))).rejects.toMatchObject({ code: '23P01' });
    await put('booking.buffer_minutes', 'branch', ids.b1!, 10, new Date('2026-06-01T00:00:00Z'));
    await put('booking.buffer_minutes', 'branch', ids.b2!, 1, T0);
  });

  it('yu_app: значение и даты начала не переписываются, строки не удаляются; valid_to – можно', async () => {
    await expect(asApp(() => db.client.query(`UPDATE app.settings_values SET value = '1'`))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(() => db.client.query('DELETE FROM app.settings_values'))).rejects.toMatchObject({ code: '42501' });
    await asApp(() => db.client.query(`UPDATE app.settings_values SET valid_to = valid_to WHERE key = 'booking.buffer_minutes'`));
  });

  it('уровень и область согласованы – CHECK', async () => {
    await expect(put('booking.hold_minutes', 'branch', null, 1, T0)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('resolveSetting: приоритет филиал → город → сеть → система, значение на дату', () => {
  const at = new Date('2026-11-15T00:00:00Z');

  it('без значений – система', async () => {
    const r = await resolveSetting(db.client, 'booking.window_default_days', { branchId: ids.b3! }, at);
    const n: number = r.value;
    expect(n).toBe(7);
    expect(r.source).toEqual({ level: 'system', valueId: null, validFrom: null });
  });

  it('сеть перекрывает систему, город – сеть, филиал – город (если уровень разрешён)', async () => {
    const net = await put('branch.default_hours', 'network', null, { open: '09:00', close: '21:00' }, T0);
    const city = await put('branch.default_hours', 'city', ids.nsk!, { open: '11:00', close: '23:00' }, T0);
    expect(await resolveSetting(db.client, 'branch.default_hours', { cityId: ids.tsk! }, at)).toMatchObject({
      value: { open: '09:00', close: '21:00' }, source: { level: 'network', valueId: net },
    });
    expect(await resolveSetting(db.client, 'branch.default_hours', { branchId: ids.b1! }, at)).toMatchObject({
      value: { open: '11:00', close: '23:00' }, source: { level: 'city', valueId: city },
    });
    const b = await put('booking.window_default_days', 'branch', ids.b1!, 14, T0);
    await put('booking.window_default_days', 'network', null, 10, T0);
    expect(await resolveSetting(db.client, 'booking.window_default_days', { branchId: ids.b1! }, at)).toMatchObject({ value: 14, source: { level: 'branch', valueId: b } });
    expect((await resolveSetting(db.client, 'booking.window_default_days', { branchId: ids.b2! }, at)).value).toBe(10);
    expect((await resolveSetting(db.client, 'booking.window_default_days', { network: true }, at)).value).toBe(10);
  });

  it('уровень, не разрешённый для ключа, не перекрывает (строка в базе есть – значение сети)', async () => {
    await put('booking.hold_minutes', 'branch', ids.b2!, 60, T0);
    expect(await resolveSetting(db.client, 'booking.hold_minutes', { branchId: ids.b2! }, at)).toMatchObject({ value: 15, source: { level: 'system' } });
  });

  it('значение на прошлую и будущую дату; закрытая строка (valid_to) больше не действует', async () => {
    expect((await resolveSetting(db.client, 'booking.buffer_minutes', { branchId: ids.b1! }, new Date('2026-03-01T00:00:00Z'))).value).toBe(5);
    expect((await resolveSetting(db.client, 'booking.buffer_minutes', { branchId: ids.b1! }, new Date('2026-06-01T00:00:00Z'))).value).toBe(10);
    expect((await resolveSetting(db.client, 'booking.buffer_minutes', { branchId: ids.b1! }, new Date('2025-12-31T23:59:59Z'))).value).toBe(0);
  });

  it('resolveSettings – пакетно одним вызовом', async () => {
    const r = await resolveSettings(db.client, ['booking.window_default_days', 'booking.window_max_days', 'booking.buffer_minutes'], { branchId: ids.b1! }, at);
    expect(r['booking.window_default_days'].value).toBe(14);
    expect(r['booking.window_max_days'].source.level).toBe('system');
    expect(r['booking.buffer_minutes'].value).toBe(10);
  });

  it('settingHistory – цепочка области, новые сверху; чужой филиал не попадает', async () => {
    const h = await settingHistory(db.client, 'booking.buffer_minutes', { branchId: ids.b1! });
    expect(h.map((x) => [x.level, x.value])).toEqual([['branch', 10], ['branch', 5]]);
    expect(h[1]!.validTo).toEqual(new Date('2026-06-01T00:00:00Z'));
  });
});
