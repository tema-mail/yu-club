// K7 по HTTP (CRM «Настройки»): действующие значения области с источником и будущими изменениями, изменение с даты,
// возврат к наследованию, история. Тонкий слой (ADR 0002 п.7): правила наследования, пределы, «max ≥ default» и
// «прошлое не переписывается» – в core/settings.ts; здесь – разбор, зона, дата по зоне области, rowVersion, ответ.
// Права (K1): смотреть – тот, у кого есть settings.branch.manage в зоне области (Владелец, Директор своей зоны);
// менять – editAction ключа (ключи Э2 и сетевые – только Владелец, решение D2-02). Чужой город/филиал – 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeDenied, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import { assertCan, can, roleAllows, type AccessContext } from '../../core/permissions.ts';
import {
  resetToInherited,
  resolveSettings,
  setSetting,
  settingDef,
  settingHistory,
  SETTINGS,
  type SettingKey,
  type SettingLevel,
  type SettingScope,
} from '../../core/settings.ts';
import { localToInstant, parseLocalDate, systemClock, todayIn, type Clock, type LocalDate, type LocalTime, type TimeZone } from '../../core/time.ts';
import { getBranch, isUuid, networkTimezones, timezonesOf } from '../network/index.ts';

export interface SettingsDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type StoredLevel = Exclude<SettingLevel, 'system'>;
const VIEW_ACTION = 'settings.branch.manage';
const KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Пределы ключа для подсказки в CRM – из той же Zod-схемы, что проверяет сервер (один источник). */
export type Constraints =
  | { kind: 'integer'; min: number | null; max: number | null; nullable: boolean }
  | { kind: 'boolean'; nullable: boolean }
  | { kind: 'enum'; options: string[]; nullable: boolean }
  | { kind: 'multi'; options: string[]; minItems: number; nullable: boolean }
  | { kind: 'list'; nullable: boolean }
  | { kind: 'time'; nullable: boolean }
  | { kind: 'datetime'; nullable: boolean }
  | { kind: 'hours'; nullable: boolean }
  | { kind: 'text'; maxLength: number; nullable: boolean };

type Json = Record<string, unknown>;
function constraintsOf(key: SettingKey): Constraints {
  let s = z.toJSONSchema(settingDef(key).schema as z.ZodType, { unrepresentable: 'any' }) as Json;
  let nullable = false;
  if (Array.isArray(s.anyOf)) {
    const parts = s.anyOf as Json[];
    nullable = parts.some((p) => p.type === 'null');
    s = parts.find((p) => p.type !== 'null') ?? {};
  }
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  if (s.type === 'integer') return { kind: 'integer', min: num(s.minimum), max: num(s.maximum), nullable };
  if (s.type === 'boolean') return { kind: 'boolean', nullable };
  if (s.type === 'object') return { kind: 'hours', nullable };
  if (s.type === 'array') {
    const items = (s.items ?? {}) as Json;
    if (Array.isArray(items.enum)) return { kind: 'multi', options: items.enum as string[], minItems: num(s.minItems) ?? 0, nullable };
    return { kind: 'list', nullable };
  }
  if (Array.isArray(s.enum)) return { kind: 'enum', options: s.enum as string[], nullable };
  if (s.format === 'date-time') return { kind: 'datetime', nullable };
  // Текст с пределом длины (префикс рекламы, реквизиты): у `HH:mm` предела нет – только шаблон.
  if (typeof s.maxLength === 'number') return { kind: 'text', maxLength: s.maxLength, nullable };
  return { kind: 'time', nullable };
}
const CONSTRAINTS = new Map(KEYS.map((k) => [k, constraintsOf(k)]));

// ---- область

const scopeQuery = z.object({ scope: z.enum(['network', 'city', 'branch']), id: z.string().optional() });

interface ScopeInfo {
  level: StoredLevel;
  id: string | null;
  scope: SettingScope;
  zones: TimeZone[];
  /** Город филиала – для «унаследовано от города …». */
  city: { id: string; name: string } | null;
  name: string | null;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

function parseScope(raw: unknown): { level: StoredLevel; id: string | null } {
  const p = scopeQuery.safeParse(raw ?? {});
  if (!p.success) throw new AppError('VALIDATION_FAILED', 400, 'Укажите уровень: сеть, город или филиал', { field: 'scope' });
  if (p.data.scope === 'network') return { level: 'network', id: null };
  if (!p.data.id) throw new AppError('VALIDATION_FAILED', 400, 'Укажите город или филиал', { field: 'id' });
  return { level: p.data.scope, id: p.data.id };
}

/** Зона K1 (вне зоны – 404, сеть не Владельцу – 403) и существование области (нет – 404, как вне зоны). */
async function loadScope(db: Db, ctx: AccessContext, raw: unknown): Promise<ScopeInfo> {
  const { level, id } = parseScope(raw);
  const scope: SettingScope = level === 'network' ? { network: true } : level === 'city' ? { cityId: id! } : { branchId: id! };
  assertCan(ctx, VIEW_ACTION, scope);
  if (level === 'network') {
    const zones = await networkTimezones(db);
    return { level, id: null, scope, zones: zones.length > 0 ? zones : ['UTC' as TimeZone], city: null, name: null };
  }
  if (!isUuid(id!)) throw notFound();
  if (level === 'city') {
    const tz = (await timezonesOf(db, { cityIds: [id!], branchIds: [] })).get(id!);
    if (!tz) throw notFound();
    return { level, id, scope, zones: [tz], city: null, name: null };
  }
  const b = await getBranch(db, id!);
  if (!b) throw notFound();
  return { level, id, scope, zones: [b.timezone], city: { id: b.cityId, name: b.cityName }, name: b.name };
}

/** «Сегодня» области: для сети – самая ранняя дата среди городов (западный город). */
function todayOf(info: ScopeInfo, clock: Clock): LocalDate {
  return info.zones.map((z) => todayIn(clock, z)).sort()[0]!;
}

/** Начало действия: полночь даты по зоне области (для сети – самая поздняя полночь среди городов);
 *  сегодня – с текущего момента. Раньше сегодняшнего – отказ: история не переписывается (15 §3.4). */
function startOf(info: ScopeInfo, raw: unknown, now: Date, clock: Clock): Date {
  let date: LocalDate;
  try {
    date = parseLocalDate(String(raw ?? ''));
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, 'Укажите дату начала в формате ГГГГ-ММ-ДД', { field: 'validFrom' });
  }
  const today = todayOf(info, clock);
  if (date < today) {
    throw new AppError('VALIDATION_FAILED', 400, 'Дата начала в прошлом: прошлое не переписывается, выберите сегодня или позже', { field: 'validFrom', today });
  }
  const midnight = Math.max(...info.zones.map((z) => localToInstant(date, '00:00' as LocalTime, z).getTime()));
  return midnight <= now.getTime() ? now : new Date(midnight);
}

// ---- представление ключа

type HistoryRow = Awaited<ReturnType<typeof settingHistory>>[number];

const ownRowsOf = (rows: HistoryRow[], level: StoredLevel) => rows.filter((r) => r.level === level);

/** Версия своего уровня: последняя своя строка и её конец. Любая запись (новое значение, возврат) её меняет. */
function versionOf(rows: HistoryRow[], level: StoredLevel): string {
  const own = ownRowsOf(rows, level).sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime())[0];
  return own ? `${own.valueId}:${own.validTo?.toISOString() ?? 'open'}` : 'none';
}

async function itemsOf(db: Db, ctx: AccessContext, info: ScopeInfo, keys: readonly SettingKey[], now: Date) {
  const resolved = await resolveSettings(db, keys, info.scope, now);
  const histories = await Promise.all(keys.map((k) => settingHistory(db, k, info.scope)));
  return keys.map((key, i) => {
    const d = settingDef(key);
    const r = resolved[key];
    const rows = histories[i]!;
    const levelAllowed = d.levels.includes(info.level);
    const src = r.source.level;
    return {
      key,
      value: r.value,
      systemDefault: d.systemDefault,
      source: {
        level: src,
        valueId: r.source.valueId,
        validFrom: r.source.validFrom,
        own: src === info.level,
        cityName: src === 'city' && info.level === 'branch' ? (info.city?.name ?? null) : null,
      },
      levels: d.levels,
      levelAllowed,
      editAction: d.editAction,
      editable: levelAllowed && can(ctx, d.editAction, info.scope),
      constraints: CONSTRAINTS.get(key)!,
      upcoming: rows
        .filter((x) => x.validFrom.getTime() > now.getTime() && d.levels.includes(x.level as StoredLevel))
        .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime())
        .map((x) => ({ valueId: x.valueId, level: x.level, value: x.value, validFrom: x.validFrom })),
      rowVersion: versionOf(rows, info.level),
    };
  });
}

function scopeView(info: ScopeInfo, clock: Clock) {
  return {
    level: info.level,
    id: info.id,
    name: info.name,
    city: info.city,
    timezone: info.zones.length === 1 ? info.zones[0]! : null,
    today: todayOf(info, clock),
  };
}

function keyOf(raw: string | undefined): SettingKey {
  if (!raw || !(raw in SETTINGS)) throw new AppError('NOT_FOUND', 404, 'Такой настройки нет');
  return raw as SettingKey;
}

const putBody = z.object({
  value: z.unknown(),
  validFrom: z.string(),
  rowVersion: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});
const resetBody = z.object({ rowVersion: z.string().min(1), reason: z.string().trim().max(500).optional() });

function body<T>(schema: z.ZodType<T>, raw: unknown): T {
  const p = schema.safeParse(raw ?? {});
  if (!p.success) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', {
      issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return p.data;
}

// ---- маршруты

type Command = (tx: Tx, ctx: AccessContext, info: ScopeInfo, key: SettingKey, raw: unknown, meta: AuditRequestMeta, now: Date) => Promise<unknown>;

export async function settingsRoutes(app: FastifyInstance, deps: SettingsDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  async function viewer(request: FastifyRequest, reply: FastifyReply) {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, VIEW_ACTION)) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: VIEW_ACTION });
    return access;
  }

  /** Своя строка не та, что видел сотрудник (другой успел изменить) – 409 с текущим видом ключа (16 §15.4). */
  async function assertVersion(tx: Tx, ctx: AccessContext, info: ScopeInfo, key: SettingKey, expected: string, now: Date) {
    const [current] = await itemsOf(tx, ctx, info, [key], now);
    if (current!.rowVersion !== expected) {
      throw new AppError('VERSION_CONFLICT', 409, 'Настройку уже изменили: обновите экран и проверьте значение', { current });
    }
  }

  function command(operation: string, run: Command) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const idemKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const key = keyOf((request.params as { key?: string }).key);
      const now = clock.now();
      let info: ScopeInfo | null = null;
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `settings.${operation}`),
            key: idemKey,
            request: { route: `${request.method} ${request.routeOptions.url}`, params: { key, ...(request.query as object) }, body: request.body ?? null },
            clock,
          },
          async () => {
            info = await loadScope(client, access, request.query);
            return { status: 200, body: await run(client, access, info, key, request.body, meta, now) };
          },
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof AppError && err.code === 'FORBIDDEN') {
          const target = info ?? (() => {
            try {
              return parseScope(request.query);
            } catch {
              return { level: 'network' as const, id: null };
            }
          })();
          await writeDenied(
            deps.pool,
            meta,
            {
              action: operation === 'reset' ? 'setting.reset_to_inherited' : 'setting.changed',
              object: { type: 'setting', id: null },
              branchId: target.level === 'branch' ? target.id : null,
              cityId: target.level === 'city' ? target.id : null,
              reason: `FORBIDDEN: ${settingDef(key).editAction} (${key})`,
              result: 'denied',
            },
            clock,
          );
        }
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }

  // 1. Действующие значения области: значение, источник, будущие изменения, можно ли менять здесь.
  app.get('/settings', async (request, reply) => {
    const access = await viewer(request, reply);
    const info = await loadScope(deps.pool, access, request.query);
    const items = await itemsOf(deps.pool, access, info, KEYS, clock.now());
    return { scope: scopeView(info, clock), items };
  });

  // 2. Изменить значение своего уровня с даты (сегодня – с текущего момента).
  app.put(
    '/settings/:key',
    command('set', async (tx, ctx, info, key, raw, meta, now) => {
      const b = body(putBody, raw);
      if (b.value === undefined) {
        throw new AppError('VALIDATION_FAILED', 400, 'Неверные данные запроса', { issues: [{ path: 'value', message: 'нужно значение' }] });
      }
      const validFrom = startOf(info, b.validFrom, now, clock);
      await assertVersion(tx, ctx, info, key, b.rowVersion, now);
      const frozen: Clock = { now: () => now };
      await setSetting(tx, ctx, { key, scope: info.scope, value: b.value as never, validFrom, ...(b.reason ? { reason: b.reason } : {}) }, meta, frozen);
      const [item] = await itemsOf(tx, ctx, info, [key], now);
      return item;
    }),
  );

  // 3. Вернуть к наследованию с текущего момента: своя строка закрывается и остаётся в истории.
  app.post(
    '/settings/:key/reset',
    command('reset', async (tx, ctx, info, key, raw, meta, now) => {
      const b = body(resetBody, raw);
      await assertVersion(tx, ctx, info, key, b.rowVersion, now);
      await resetToInherited(tx, ctx, { key, scope: info.scope, at: now, ...(b.reason ? { reason: b.reason } : {}) }, meta, { now: () => now });
      const [item] = await itemsOf(tx, ctx, info, [key], now);
      return item;
    }),
  );

  // 4. История ключа по цепочке области (новые сверху) со статусом относительно текущего момента.
  app.get('/settings/:key/history', async (request, reply) => {
    const access = await viewer(request, reply);
    const key = keyOf((request.params as { key?: string }).key);
    const info = await loadScope(deps.pool, access, request.query);
    const now = clock.now().getTime();
    const rows = await settingHistory(deps.pool, key, info.scope);
    return {
      key,
      items: rows.map((r) => ({
        ...r,
        own: r.level === info.level,
        status: r.validFrom.getTime() > now ? 'planned' : r.validTo !== null && r.validTo.getTime() <= now ? 'ended' : 'active',
      })),
    };
  });
}
