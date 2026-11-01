// Мок экрана «Настройки» строго по apps/api/src/modules/settings/routes.crm.ts и core/settings.ts (K7 «HTTP CRM»):
// GET /settings, PUT /settings/{key}, POST /settings/{key}/reset, GET /settings/{key}/history. Область – ?scope=&id=,
// наследование филиал → город → сеть → система на разрешённых уровнях, дата начала по зоне области, rowVersion,
// Idempotency-Key, «max ≥ default», пересечение дат, права K1 (смотреть – settings.branch.manage в зоне).
// Подключается из mock-api.ts (registerSettings), resetSettings() – POST /__test/reset.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

type Rec = Record<string, unknown>;
type Stored = 'network' | 'city' | 'branch';
type Level = 'system' | Stored;
interface Staffish { id: string; role: string }
interface Zone { network: boolean; cityIds: string[]; branchIds: string[] }
interface BranchLite { id: string; cityId: string; cityName: string; name: string; timezone: string }

export interface SettingsMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => Zone;
  can: (s: Staffish, action: string) => boolean;
  branches: () => BranchLite[];
  fail: (reply: FastifyReply, status: number, code: string, message: string, details?: Rec) => unknown;
  audit: (s: Staffish, objectType: string, objectId: string, action: string, before: object, after: object, reason?: string | null) => void;
}

// ---- реестр ключей (core/settings.ts SETTINGS): уровни, право, системное значение, пределы, проверка

type C =
  | { kind: 'integer'; min: number | null; max: number | null; nullable: boolean }
  | { kind: 'boolean' | 'list' | 'time' | 'datetime' | 'hours'; nullable: boolean }
  | { kind: 'enum'; options: string[]; nullable: boolean }
  | { kind: 'multi'; options: string[]; minItems: number; nullable: boolean };
interface Def { levels: Stored[]; editAction: string; systemDefault: unknown; constraints: C }
const NB: Stored[] = ['network', 'branch'];
const N: Stored[] = ['network'];
const BR = 'settings.branch.manage';
const NET = 'settings.network.manage';
const int = (min: number, max: number, nullable = false): C => ({ kind: 'integer', min, max, nullable });
const bool: C = { kind: 'boolean', nullable: false };
const d = (constraints: C, systemDefault: unknown, levels: Stored[], editAction: string): Def => ({ levels, editAction, systemDefault, constraints });

const DEFS: Record<string, Def> = {
  'booking.window_default_days': d(int(1, 30), 7, NB, BR),
  'booking.window_max_days': d(int(1, 90), 30, NB, BR),
  'booking.hold_minutes': d(int(5, 60), 15, N, NET),
  'booking.buffer_minutes': d(int(0, 60), 0, NB, BR),
  'booking.max_hold_items': d(int(1, 20), 10, N, NET),
  'booking.max_anonymous_holds_per_branch': d(int(0, 500), 30, NB, BR),
  'booking.client_cancel_enabled': d(bool, true, N, NET),
  'visit.arrive_early_min': d(int(0, 1440), 30, ['network', 'city', 'branch'], BR),
  'notifications.reminder_day_before_time': d({ kind: 'time', nullable: false }, '21:00', N, NET),
  'notifications.reminder_before_minutes': d(int(5, 120), 15, N, NET),
  'notifications.push_retry_limit': d(int(0, 5), 3, N, NET),
  'staff.session_idle_minutes': d(int(15, 1440), 480, N, NET),
  'staff.session_absolute_hours': d(int(1, 720), 72, N, NET),
  'staff.login_max_failures': d(int(3, 20), 10, N, NET),
  'staff.login_lock_minutes': d(int(1, 60), 15, N, NET),
  'client.otp_ttl_seconds': d(int(60, 900), 300, N, NET),
  'client.otp_max_attempts': d(int(3, 10), 5, N, NET),
  'client.otp_resend_cooldown_seconds': d(int(30, 600), 60, N, NET),
  'client.otp_max_per_phone_per_hour': d(int(1, 20), 5, N, NET),
  'client.session_days': d(int(1, 365), 30, N, NET),
  'branch.default_hours': d({ kind: 'hours', nullable: false }, { open: '10:00', close: '22:00' }, ['network', 'city'], NET),
  'payment.certificate_topup_enabled': d(bool, false, N, NET),
  'finance.negative_balance_allowed': d(bool, false, NB, NET),
  'finance.cash_shift_enabled': d(bool, false, NB, NET),
  'certificate.sale_methods': d({ kind: 'multi', options: ['cash', 'card', 'transfer'], minItems: 1, nullable: false }, ['cash', 'card', 'transfer'], N, NET),
  'certificate.nominal_min_kop': d(int(1, 100_000_000, true), null, N, NET),
  'certificate.nominal_max_kop': d(int(1, 100_000_000, true), null, N, NET),
  'loyalty.batch_ttl_days': d(int(1, 3650, true), null, N, NET),
  'loyalty.penalty_scope': d({ kind: 'enum', options: ['visit', 'booking'], nullable: false }, 'visit', N, NET),
  'loyalty.penalties_from': d({ kind: 'datetime', nullable: true }, null, N, NET),
  'loyalty.points_resource_types': d({ kind: 'list', nullable: false }, ['pc', 'vr_seat', 'ps_room'], N, NET),
  'loyalty.accrue_for_points': d(bool, false, N, NET),
  'loyalty.accrue_for_certificate': d(bool, true, N, NET),
};
const KEYS = Object.keys(DEFS);

/** Схема ключа (Zod в core): false – SETTING_INVALID. */
function valid(c: C, v: unknown): boolean {
  if (v === null) return c.nullable;
  switch (c.kind) {
    case 'integer': return Number.isInteger(v) && (c.min === null || (v as number) >= c.min) && (c.max === null || (v as number) <= c.max);
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return c.options.includes(v as string);
    case 'multi': return Array.isArray(v) && v.length >= c.minItems && v.every((x) => c.options.includes(x)) && new Set(v).size === v.length;
    case 'list': return Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9_]*$/.test(x)) && new Set(v).size === v.length;
    case 'time': return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    case 'datetime': return typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.endsWith('Z');
    case 'hours': {
      const h = v as { open?: unknown; close?: unknown };
      const t = (x: unknown) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
      return typeof v === 'object' && t(h.open) && t(h.close) && (h.close as string) > (h.open as string);
    }
  }
}

// ---- состояние

interface Row { id: string; key: string; level: Stored; scopeId: string | null; value: unknown; validFrom: number; validTo: number | null; reason: string | null; createdBy: string }
let rows: Row[] = [];
const replays = new Map<string, { status: number; body: unknown }>();

export function resetSettings(): void {
  rows = [];
  replays.clear();
}

// ---- время по зоне (core/time.ts todayIn, localToInstant)

function todayIn(tz: string, now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now));
}
function midnight(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess));
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return guess - (Date.parse(`${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:00Z`) - guess);
}

// ---- маршруты

interface Scope { level: Stored; id: string | null; zones: string[]; city: { id: string; name: string } | null; name: string | null; cityOf: string | null }

export function registerSettings(app: FastifyInstance, P: string, deps: SettingsMockDeps): void {
  const RANK: Record<Stored, number> = { network: 1, city: 2, branch: 3 };

  /** Строки цепочки области: сеть, город (свой или филиала), филиал. */
  const inChain = (sc: Scope, r: Row) =>
    r.level === 'network' || (r.level === 'city' && r.scopeId === (sc.level === 'city' ? sc.id : sc.cityOf)) || (r.level === 'branch' && sc.level === 'branch' && r.scopeId === sc.id);

  function resolve(sc: Scope, key: string, at: number): { value: unknown; source: { level: Level; valueId: string | null; validFrom: string | null } } {
    const def = DEFS[key]!;
    let best: Row | undefined;
    for (const r of rows) {
      if (r.key !== key || !inChain(sc, r) || !def.levels.includes(r.level) || r.validFrom > at || (r.validTo !== null && r.validTo <= at)) continue;
      if (!best || RANK[r.level] > RANK[best.level]) best = r;
    }
    return best
      ? { value: best.value, source: { level: best.level, valueId: best.id, validFrom: new Date(best.validFrom).toISOString() } }
      : { value: def.systemDefault, source: { level: 'system', valueId: null, validFrom: null } };
  }

  const inZone = (z: Zone, sc: Scope) => z.network || (sc.level === 'city' ? z.cityIds.includes(sc.id!) : sc.level === 'branch' && z.branchIds.includes(sc.id!));
  const canAt = (s: Staffish, action: string, sc: Scope) => deps.can(s, action) && inZone(deps.zone(s), sc);
  const own = (sc: Scope, key: string) => rows.filter((r) => r.key === key && r.level === sc.level && r.scopeId === sc.id);

  function version(sc: Scope, key: string): string {
    const last = own(sc, key).sort((a, b) => b.validFrom - a.validFrom)[0];
    return last ? `${last.id}:${last.validTo === null ? 'open' : new Date(last.validTo).toISOString()}` : 'none';
  }

  function item(s: Staffish, sc: Scope, key: string, now: number) {
    const def = DEFS[key]!;
    const r = resolve(sc, key, now);
    const levelAllowed = def.levels.includes(sc.level);
    return {
      key, value: r.value, systemDefault: def.systemDefault,
      source: { ...r.source, own: r.source.level === sc.level, cityName: r.source.level === 'city' && sc.level === 'branch' ? (sc.city?.name ?? null) : null },
      levels: def.levels, levelAllowed, editAction: def.editAction, editable: levelAllowed && canAt(s, def.editAction, sc), constraints: def.constraints,
      upcoming: rows.filter((x) => x.key === key && inChain(sc, x) && def.levels.includes(x.level) && x.validFrom > now)
        .sort((a, b) => a.validFrom - b.validFrom)
        .map((x) => ({ valueId: x.id, level: x.level, value: x.value, validFrom: new Date(x.validFrom).toISOString() })),
      rowVersion: version(sc, key),
    };
  }

  /** loadScope: уровень и id, зона (вне – 404, сеть не Владельцу – 403), существование. */
  function scopeOf(req: FastifyRequest, reply: FastifyReply, s: Staffish, action = BR): Scope | null {
    const q = req.query as { scope?: string; id?: string };
    if (q.scope !== 'network' && q.scope !== 'city' && q.scope !== 'branch') {
      deps.fail(reply, 400, 'VALIDATION_FAILED', 'Укажите уровень: сеть, город или филиал', { field: 'scope' });
      return null;
    }
    if (q.scope !== 'network' && !q.id) {
      deps.fail(reply, 400, 'VALIDATION_FAILED', 'Укажите город или филиал', { field: 'id' });
      return null;
    }
    const z = deps.zone(s);
    const bs = deps.branches();
    if (q.scope === 'network') {
      if (!z.network) { deps.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action }); return null; }
      return { level: 'network', id: null, zones: [...new Set(bs.map((b) => b.timezone))].sort(), city: null, name: null, cityOf: null };
    }
    const sc: Scope = { level: q.scope, id: q.id!, zones: [], city: null, name: null, cityOf: null };
    if (!inZone(z, sc)) { deps.fail(reply, 404, 'NOT_FOUND', 'Не найдено'); return null; }
    if (!deps.can(s, action)) { deps.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action }); return null; }
    if (q.scope === 'city') {
      const b = bs.find((x) => x.cityId === q.id);
      if (!b) { deps.fail(reply, 404, 'NOT_FOUND', 'Не найдено'); return null; }
      return { ...sc, zones: [b.timezone] };
    }
    const b = bs.find((x) => x.id === q.id);
    if (!b) { deps.fail(reply, 404, 'NOT_FOUND', 'Не найдено'); return null; }
    return { ...sc, zones: [b.timezone], city: { id: b.cityId, name: b.cityName }, name: b.name, cityOf: b.cityId };
  }

  const todayOf = (sc: Scope, now: number) => sc.zones.map((z) => todayIn(z, now)).sort()[0]!;
  const scopeView = (sc: Scope, now: number) => ({ level: sc.level, id: sc.id, name: sc.name, city: sc.city, timezone: sc.zones.length === 1 ? sc.zones[0] : null, today: todayOf(sc, now) });

  const viewer = (req: FastifyRequest, reply: FastifyReply) => {
    const s = deps.current(req);
    if (!deps.can(s, BR)) { deps.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: BR }); return null; }
    return s;
  };
  const keyOf = (req: FastifyRequest, reply: FastifyReply) => {
    const key = (req.params as { key: string }).key;
    if (!(key in DEFS)) { deps.fail(reply, 404, 'NOT_FOUND', 'Такой настройки нет'); return null; }
    return key;
  };

  /** assertWindowPair: в области (для сети – и в каждом филиале) на дату и все будущие точки max ≥ default. */
  function windowBroken(sc: Scope, key: string, from: number): { max: number; def: number } | null {
    if (key !== 'booking.window_default_days' && key !== 'booking.window_max_days') return null;
    const scopes: Scope[] = [sc];
    if (sc.level === 'network') for (const b of deps.branches()) scopes.push({ level: 'branch', id: b.id, zones: [b.timezone], city: null, name: null, cityOf: b.cityId });
    const pts = new Set<number>([from]);
    for (const r of rows) if (r.key.startsWith('booking.window_')) for (const t of [r.validFrom, r.validTo]) if (t !== null && t > from) pts.add(t);
    for (const x of scopes) for (const t of pts) {
      const def = resolve(x, 'booking.window_default_days', t).value as number;
      const max = resolve(x, 'booking.window_max_days', t).value as number;
      if (max < def) return { max, def };
    }
    return null;
  }

  function command(op: 'set' | 'reset', run: (s: Staffish, sc: Scope, key: string, body: Rec, reply: FastifyReply, now: number) => unknown) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const s = deps.current(req);
      const idem = req.headers['idempotency-key'];
      if (!idem) return deps.fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      const memo = replays.get(`${s.id}:${op}:${String(idem)}`);
      if (memo) return reply.code(memo.status).header('idempotent-replay', 'true').send(memo.body);
      const key = keyOf(req, reply);
      if (!key) return reply;
      const sc = scopeOf(req, reply, s);
      if (!sc) return reply;
      const before = rows.map((r) => ({ ...r }));
      const out = run(s, sc, key, (req.body ?? {}) as Rec, reply, Date.now());
      if (reply.sent) { rows = before; return reply; }
      replays.set(`${s.id}:${op}:${String(idem)}`, { status: 200, body: out });
      return out;
    };
  }

  const conflict = (s: Staffish, sc: Scope, key: string, body: Rec, reply: FastifyReply, now: number) => {
    if (typeof body.rowVersion !== 'string' || body.rowVersion === '') {
      deps.fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path: 'rowVersion', message: 'обязательно' }] });
      return true;
    }
    if (body.rowVersion !== version(sc, key)) {
      deps.fail(reply, 409, 'VERSION_CONFLICT', 'Настройку уже изменили: обновите экран и проверьте значение', { current: item(s, sc, key, now) });
      return true;
    }
    return false;
  };

  /** prepare: уровень разрешён, право editAction в зоне. */
  const prepared = (s: Staffish, sc: Scope, key: string, reply: FastifyReply) => {
    const def = DEFS[key]!;
    if (!def.levels.includes(sc.level)) {
      deps.fail(reply, 422, 'SETTING_LEVEL_NOT_ALLOWED', 'Для этой настройки такой уровень не предусмотрен', { key, level: sc.level, allowed: def.levels });
      return false;
    }
    if (!canAt(s, def.editAction, sc)) {
      deps.fail(reply, 403, 'FORBIDDEN', 'Недостаточно прав', { action: def.editAction });
      return false;
    }
    return true;
  };

  app.get(`${P}/settings`, async (req, reply) => {
    const s = viewer(req, reply);
    if (!s) return reply;
    const sc = scopeOf(req, reply, s);
    if (!sc) return reply;
    const now = Date.now();
    return { scope: scopeView(sc, now), items: KEYS.map((k) => item(s, sc, k, now)) };
  });

  app.put(`${P}/settings/:key`, command('set', (s, sc, key, body, reply, now) => {
    if (!('value' in body) || typeof body.validFrom !== 'string') {
      return deps.fail(reply, 400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues: [{ path: 'value', message: 'нужно значение' }] });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.validFrom)) return deps.fail(reply, 400, 'VALIDATION_FAILED', 'Укажите дату начала в формате ГГГГ-ММ-ДД', { field: 'validFrom' });
    const today = todayOf(sc, now);
    if (body.validFrom < today) {
      return deps.fail(reply, 400, 'VALIDATION_FAILED', 'Дата начала в прошлом: прошлое не переписывается, выберите сегодня или позже', { field: 'validFrom', today });
    }
    if (conflict(s, sc, key, body, reply, now)) return undefined;
    if (!prepared(s, sc, key, reply)) return undefined;
    const def = DEFS[key]!;
    if (!valid(def.constraints, body.value)) {
      return deps.fail(reply, 422, 'SETTING_INVALID', 'Значение настройки вне допустимого', { key, issues: [{ path: '', message: 'вне пределов схемы' }] });
    }
    const m = Math.max(...sc.zones.map((z) => midnight(body.validFrom as string, z)));
    const from = m <= now ? now : m;
    const mine = own(sc, key).filter((r) => r.validTo === null || r.validTo > from);
    const current = mine.find((r) => r.validFrom < from);
    const other = mine.find((r) => r !== current);
    if (other) return deps.fail(reply, 409, 'SETTING_PERIOD_OVERLAP', 'На эти даты уже есть значение этого уровня', { conflictValueId: other.id });
    const was = resolve(sc, key, from);
    if (current) current.validTo = from;
    const row: Row = { id: randomUUID(), key, level: sc.level, scopeId: sc.id, value: body.value, validFrom: from, validTo: null, reason: typeof body.reason === 'string' ? body.reason : null, createdBy: s.id };
    rows.push(row);
    const broken = windowBroken(sc, key, from);
    if (broken) {
      return deps.fail(reply, 422, 'SETTING_INVALID', 'Максимальное окно записи меньше окна по умолчанию', {
        key, issues: [{ path: '', message: `window_max_days (${broken.max}) < window_default_days (${broken.def})` }],
      });
    }
    deps.audit(s, 'setting', row.id, 'setting.changed', { key, value: was.value, level: was.source.level }, { key, value: body.value, level: sc.level }, row.reason);
    return item(s, sc, key, now);
  }));

  app.post(`${P}/settings/:key/reset`, command('reset', (s, sc, key, body, reply, now) => {
    if (conflict(s, sc, key, body, reply, now)) return undefined;
    if (!prepared(s, sc, key, reply)) return undefined;
    const mine = own(sc, key).filter((r) => r.validTo === null || r.validTo > now);
    const current = mine.find((r) => r.validFrom < now);
    const future = mine.find((r) => r !== current);
    if (future) return deps.fail(reply, 409, 'SETTING_PERIOD_OVERLAP', 'На эти даты уже есть значение этого уровня', { conflictValueId: future.id });
    if (!current) return item(s, sc, key, now);
    current.validTo = now;
    const broken = windowBroken(sc, key, now);
    if (broken) {
      return deps.fail(reply, 422, 'SETTING_INVALID', 'Максимальное окно записи меньше окна по умолчанию', {
        key, issues: [{ path: '', message: `window_max_days (${broken.max}) < window_default_days (${broken.def})` }],
      });
    }
    const next = resolve(sc, key, now);
    deps.audit(s, 'setting', current.id, 'setting.reset_to_inherited', { key, value: current.value, level: sc.level }, { key, value: next.value, level: next.source.level }, typeof body.reason === 'string' ? body.reason : null);
    return item(s, sc, key, now);
  }));

  app.get(`${P}/settings/:key/history`, async (req, reply) => {
    const s = viewer(req, reply);
    if (!s) return reply;
    const key = keyOf(req, reply);
    if (!key) return reply;
    const sc = scopeOf(req, reply, s);
    if (!sc) return reply;
    const now = Date.now();
    const list = rows.filter((r) => r.key === key && inChain(sc, r)).sort((a, b) => b.validFrom - a.validFrom || a.level.localeCompare(b.level));
    return {
      key,
      items: list.map((r) => ({
        valueId: r.id, level: r.level, value: r.value, validFrom: new Date(r.validFrom).toISOString(), validTo: r.validTo === null ? null : new Date(r.validTo).toISOString(),
        createdBy: r.createdBy, reason: r.reason, own: r.level === sc.level,
        status: r.validFrom > now ? 'planned' : r.validTo !== null && r.validTo <= now ? 'ended' : 'active',
      })),
    };
  });
}
