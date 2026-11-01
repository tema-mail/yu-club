import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { errorStatus, registeredAuditActions } from '../../apps/api/src/core/registry.ts';
import {
  resetToInherited,
  resolveSetting,
  resolveSettings,
  setSetting,
  SETTINGS,
  settingDef,
  settingHistory,
} from '../../apps/api/src/core/settings.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
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
    expect(SETTINGS['visit.arrive_early_min'].systemDefault).toBe(30); // Q-101
    expect(SETTINGS['visit.arrive_early_min'].levels).toEqual(['network', 'city', 'branch']);
    expect(Object.keys(SETTINGS)).toHaveLength(33); // 21 ключ Э0–Э1 + 12 Э2 (K7)
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

describe('setSetting / resetToInherited: проверки до сохранения, история, аудит', () => {
  const clock = fixedClock('2026-11-20T00:00:00Z');
  const d = (iso: string) => new Date(iso);
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
  const owner = ctx('owner');
  const KEY = 'booking.max_anonymous_holds_per_branch' as const;

  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    await db.client.query('BEGIN');
    try {
      const r = await fn();
      await db.client.query('COMMIT');
      return r;
    } catch (err) {
      await db.client.query('ROLLBACK');
      throw err;
    }
  }
  const set = (c: AccessContext, input: Parameters<typeof setSetting>[2]) => inTx(() => setSetting(db.client, c, input, meta(c), clock));
  const reset = (c: AccessContext, input: Parameters<typeof resetToInherited>[2]) => inTx(() => resetToInherited(db.client, c, input, meta(c), clock));

  it('коды K7 и действия аудита в реестре', () => {
    expect(errorStatus.SETTING_INVALID).toBe(422);
    expect(errorStatus.SETTING_LEVEL_NOT_ALLOWED).toBe(422);
    expect(errorStatus.SETTING_PERIOD_OVERLAP).toBe(409);
    expect(registeredAuditActions.has('setting.changed')).toBe(true);
    expect(registeredAuditActions.has('setting.reset_to_inherited')).toBe(true);
  });

  it('уровень не разрешён, значение вне пределов, прошлая дата, нет права – до записи', async () => {
    await expect(set(owner, { key: 'booking.hold_minutes', scope: { branchId: ids.b3! }, value: 20, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({ code: 'SETTING_LEVEL_NOT_ALLOWED' });
    await expect(set(owner, { key: KEY, scope: { branchId: ids.b3! }, value: 501, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({ code: 'SETTING_INVALID' });
    await expect(set(owner, { key: KEY, scope: { branchId: ids.b3! }, value: 5, validFrom: d('2026-11-19T00:00:00Z') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const admin = ctx('admin', { branchIds: [ids.b3!] });
    await expect(set(admin, { key: KEY, scope: { branchId: ids.b3! }, value: 5, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const dir = ctx('director', { cityIds: [ids.nsk!], branchIds: [ids.b1!, ids.b2!] });
    await expect(set(dir, { key: KEY, scope: { branchId: ids.b3! }, value: 5, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(set(dir, { key: KEY, scope: { network: true }, value: 5, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(owner, { key: KEY, scope: { branchId: randomUUID() }, value: 5, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const n = await db.client.query(`SELECT count(*)::int n FROM app.settings_values WHERE key = $1`, [KEY]);
    expect(n.rows[0].n).toBe(0);
  });

  it('окно: максимум меньше окна по умолчанию – SETTING_INVALID', async () => {
    await expect(set(owner, { key: 'booking.window_max_days', scope: { branchId: ids.b1! }, value: 10, validFrom: d('2026-12-01T00:00:00Z') })).rejects.toMatchObject({
      code: 'SETTING_INVALID',
    }); // у b1 окно по умолчанию 14
  });

  it('окно, сеть: максимум сети ниже собственного окна по умолчанию филиала – SETTING_INVALID, в базе пусто даже после COMMIT', async () => {
    await db.client.query('BEGIN');
    const err = await setSetting(db.client, owner, { key: 'booking.window_max_days', scope: { network: true }, value: 12, validFrom: d('2026-12-01T00:00:00Z') }, meta(owner), clock).catch((e: unknown) => e);
    await db.client.query('COMMIT'); // SAVEPOINT уже откатил запись – фиксировать нечего
    expect(err).toMatchObject({ code: 'SETTING_INVALID', details: { scope: { branchId: ids.b1 } } }); // у сети 10 ≤ 12, у b1 своё 14
    const n = await db.client.query(`SELECT count(*)::int n FROM app.settings_values WHERE key = 'booking.window_max_days'`);
    expect(n.rows[0].n).toBe(0);
    await set(owner, { key: 'booking.window_max_days', scope: { network: true }, value: 14, validFrom: d('2026-12-01T00:00:00Z') });
  });

  it('окно, будущие записи: максимум филиала ниже запланированного окна по умолчанию – SETTING_INVALID; сброс, ломающий пару, – тоже', async () => {
    await set(owner, { key: 'booking.window_max_days', scope: { branchId: ids.b2! }, value: 25, validFrom: d('2026-11-25T00:00:00Z') });
    await set(owner, { key: 'booking.window_default_days', scope: { branchId: ids.b2! }, value: 20, validFrom: d('2026-12-10T00:00:00Z') });
    await expect(set(owner, { key: 'booking.window_max_days', scope: { branchId: ids.b2! }, value: 15, validFrom: d('2026-11-26T00:00:00Z') })).rejects.toMatchObject({
      code: 'SETTING_INVALID',
      details: { at: '2026-12-10T00:00:00.000Z' }, // 26.11: 10 ≤ 15, а с 10.12: 20 > 15
    });
    // своё окно 20 сверх сетевого максимума 14 – тоже нельзя, если свой максимум не задан (b3)
    await expect(set(owner, { key: 'booking.window_default_days', scope: { branchId: ids.b3! }, value: 20, validFrom: d('2026-12-10T00:00:00Z') })).rejects.toMatchObject({ code: 'SETTING_INVALID' });
    // сброс максимума b2 к сети (14 с 01.12) при своём окне 20 с 10.12 – нарушение
    await expect(reset(owner, { key: 'booking.window_max_days', scope: { branchId: ids.b2! }, at: d('2026-11-26T00:00:00Z') })).rejects.toMatchObject({ code: 'SETTING_INVALID' });
    expect((await resolveSetting(db.client, 'booking.window_max_days', { branchId: ids.b2! }, d('2026-12-11T00:00:00Z'))).value).toBe(25);
  });

  it('значение с даты: текущее закрывается этой датой, новое действует с неё; аудит было/стало', async () => {
    const dir = ctx('director', { cityIds: [ids.nsk!], branchIds: [ids.b1!, ids.b2!] });
    const first = await set(owner, { key: KEY, scope: { network: true }, value: 40, validFrom: d('2026-11-21T00:00:00Z') });
    const a = await set(dir, { key: KEY, scope: { branchId: ids.b1! }, value: 50, validFrom: d('2026-11-22T00:00:00Z'), reason: 'много ботов' });
    const b = await set(dir, { key: KEY, scope: { branchId: ids.b1! }, value: 60, validFrom: d('2026-12-01T00:00:00Z') });
    const at = (iso: string) => resolveSetting(db.client, KEY, { branchId: ids.b1! }, d(iso));
    expect((await at('2026-11-21T12:00:00Z')).value).toBe(40);
    expect(await at('2026-11-25T00:00:00Z')).toMatchObject({ value: 50, source: { level: 'branch', valueId: a.valueId } });
    expect(await at('2026-12-02T00:00:00Z')).toMatchObject({ value: 60, source: { valueId: b.valueId } });
    const audit = await db.client.query(`SELECT before, after, reason, branch_id FROM journal.audit_events WHERE action = 'setting.changed' AND object_id = $1`, [a.valueId]);
    expect(audit.rows[0]).toMatchObject({
      before: { key: KEY, value: 40, level: 'network' },
      after: { key: KEY, value: 50, level: 'branch' },
      reason: 'много ботов',
      branch_id: ids.b1,
    });
    expect(first.valueId).toBeTruthy();
  });

  it('пересечение дат: запланированное значение того же уровня – SETTING_PERIOD_OVERLAP до сохранения', async () => {
    const err = await set(owner, { key: KEY, scope: { branchId: ids.b1! }, value: 70, validFrom: d('2026-11-25T00:00:00Z') }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SETTING_PERIOD_OVERLAP', httpStatus: 409 });
    const planned = (await settingHistory(db.client, KEY, { branchId: ids.b1! })).find((h) => h.value === 60)!;
    expect((err as { details: { conflictValueId: string } }).details.conflictValueId).toBe(planned.valueId);
    await expect(reset(owner, { key: KEY, scope: { branchId: ids.b1! }, at: d('2026-11-25T00:00:00Z') })).rejects.toMatchObject({ code: 'SETTING_PERIOD_OVERLAP' });
  });

  it('возврат к наследованию: филиал → город нельзя (уровень), филиал → сеть → система; старое – в истории', async () => {
    await reset(owner, { key: KEY, scope: { branchId: ids.b1! }, at: d('2026-12-05T00:00:00Z'), reason: 'вернуть сетевое' });
    expect(await resolveSetting(db.client, KEY, { branchId: ids.b1! }, d('2026-12-06T00:00:00Z'))).toMatchObject({ value: 40, source: { level: 'network' } });
    await reset(owner, { key: KEY, scope: { network: true }, at: d('2026-12-07T00:00:00Z') });
    expect(await resolveSetting(db.client, KEY, { branchId: ids.b1! }, d('2026-12-08T00:00:00Z'))).toMatchObject({ value: 30, source: { level: 'system' } });
    const h = await settingHistory(db.client, KEY, { branchId: ids.b1! });
    expect(h.map((x) => [x.level, x.value, x.validTo?.toISOString() ?? null])).toEqual([
      ['branch', 60, '2026-12-05T00:00:00.000Z'],
      ['branch', 50, '2026-12-01T00:00:00.000Z'],
      ['network', 40, '2026-12-07T00:00:00.000Z'],
    ]);
    expect((await resolveSetting(db.client, KEY, { branchId: ids.b1! }, d('2026-12-02T00:00:00Z'))).value).toBe(60); // прошлое на дату – как было
    const audit = await db.client.query(`SELECT before, after, reason FROM journal.audit_events WHERE action = 'setting.reset_to_inherited' ORDER BY occurred_at, id`);
    expect(audit.rows[0]).toMatchObject({ before: { value: 60, level: 'branch' }, after: { value: 40, level: 'network' }, reason: 'вернуть сетевое' });
    await reset(owner, { key: KEY, scope: { branchId: ids.b1! }, at: d('2026-12-10T00:00:00Z') }); // нечего закрывать – без ошибки
  });

  it('город: значение города действует на его филиалы и не на чужие (цепочка фиксирована – цикла нет)', async () => {
    await set(owner, { key: 'branch.default_hours', scope: { cityId: ids.tsk! }, value: { open: '12:00', close: '20:00' }, validFrom: d('2026-12-01T00:00:00Z') });
    expect((await resolveSetting(db.client, 'branch.default_hours', { branchId: ids.b3! }, d('2026-12-02T00:00:00Z'))).value).toEqual({ open: '12:00', close: '20:00' });
    expect((await resolveSetting(db.client, 'branch.default_hours', { branchId: ids.b1! }, d('2026-12-02T00:00:00Z'))).value).toEqual({ open: '11:00', close: '23:00' });
    await expect(
      set(owner, { key: 'branch.default_hours', scope: { cityId: ids.tsk! }, value: { open: '22:00', close: '10:00' }, validFrom: d('2026-12-03T00:00:00Z') }),
    ).rejects.toMatchObject({ code: 'SETTING_INVALID' });
  });
});
