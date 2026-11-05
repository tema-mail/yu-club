// S3-14. K18 №301–310: CRM-маршруты смен на /api/crm/v1 – тонкий слой (ADR 0002 п.7): разбор пути → команда в транзакции под
// Idempotency-Key (ADR 0004) → ответ. Права – K1 по филиалу: вне зоны – 404 с телом несуществующего, в зоне без права – 403 и
// запись отказа в аудит отдельной транзакцией (ADR 0005 п.8). Суммы (plannedAccrualKop, factAccrualKop) – только с payroll.view
// на филиал смены (K18 §14 №301), в том числе в ответах команд и сохранённых ответах идемпотентности. Чтения смен несут staffName – только имя:
// Администратор видит, кто работает (K18 §12), но контактов, фамилии и ставок коллег не получает (/staff ему закрыт).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit, writeDenied, type AuditAction, type AuditObjectType, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, requireIdempotencyKey, runIdempotent } from '../../core/idempotency.ts';
import type { Tx } from '../../core/ledger.ts';
import { assertCan, branchScopeSql, can, roleAllows, scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { addDays, parseLocalDate, systemClock, type Clock, type LocalDate } from '../../core/time.ts';
import { checkIn, checkOut, setAttendance } from './attendance.ts';
import { coverage, MAX_COVERAGE_DAYS } from './coverage.ts';
import { cancelShift, createShift, getShift, setEmployment, setPlanningStatus, SHIFT_SELECT, shiftDtos, staffTargets, updateShift, type ShiftDto, type ShiftRow } from './plan.ts';
import { isUuid, listRates, notFound, setRate } from './rates.ts';

export interface ShiftsCrmDeps {
  pool: Db & { connect(): Promise<pg.PoolClient> };
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<{ access: AccessContext; meta: AuditRequestMeta }>;
  clock?: Clock;
}

type Command = (tx: Tx, ctx: AccessContext, params: Record<string, string>, body: Record<string, unknown>, meta: AuditRequestMeta, clock: Clock) => Promise<unknown>;

const objectBody = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});

/** Без payroll.view на филиал смены суммы – null (Администратор не видит и своих, Q-108). */
export function maskShift(ctx: AccessContext, dto: ShiftDto): ShiftDto {
  return can(ctx, 'payroll.view', { branchId: dto.branchId }) ? dto : { ...dto, plannedAccrualKop: null, factAccrualKop: null };
}

/** Своя смена видна и вне текущей зоны; чужая – только с shift.view в филиале; иначе 404. */
function canSee(ctx: AccessContext, dto: { staffId: string; branchId: string }): boolean {
  return dto.staffId === ctx.actor.staffId || can(ctx, 'shift.view', { branchId: dto.branchId });
}

const listSchema = z.object({
  branchIds: z.string().optional(),
  staffId: z.string().optional(),
  from: z.string(),
  to: z.string(),
  status: z.enum(['planned', 'worked', 'no_show', 'cancelled', 'needs_review']).optional(),
});

function parseRange(from: string, to: string): { from: LocalDate; to: LocalDate } {
  try {
    const f = parseLocalDate(from);
    const t = parseLocalDate(to);
    if (f > t || addDays(f, MAX_COVERAGE_DAYS - 1) < t) throw new Error('range');
    return { from: f, to: t };
  } catch {
    throw new AppError('VALIDATION_FAILED', 400, `Период – даты ГГГГ-ММ-ДД, не больше ${MAX_COVERAGE_DAYS} дней`, { maxDays: MAX_COVERAGE_DAYS });
  }
}

export type ShiftView = ShiftDto & { staffName: string };

/** Имя сотрудника смены (без фамилии и контактов). Вызывать только для смен, которые вызывающий уже вправе видеть. */
async function withNames(db: Db, items: ShiftDto[]): Promise<ShiftView[]> {
  if (items.length === 0) return [];
  const r = await db.query<{ id: string; first_name: string }>(`SELECT id, first_name FROM app.staff WHERE id = ANY($1::uuid[])`, [[...new Set(items.map((d) => d.staffId))]]);
  const names = new Map(r.rows.map((x) => [x.id, x.first_name]));
  return items.map((d) => ({ ...d, staffName: names.get(d.staffId) ?? '' }));
}

/** №301: смены в зоне shift.view плюс свои; явно названный филиал вне зоны – 404. */
async function listShifts(db: Db, ctx: AccessContext, query: unknown, clock: Clock): Promise<{ items: ShiftView[] }> {
  const parsed = listSchema.safeParse(query ?? {});
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 400, 'Нужны даты from и to');
  const q = parsed.data;
  const range = parseRange(q.from, q.to);
  const branchIds = q.branchIds ? q.branchIds.split(',').filter(Boolean) : [];
  for (const id of branchIds) if (!isUuid(id) || !can(ctx, 'shift.view', { branchId: id })) throw notFound();
  if (q.staffId !== undefined && !isUuid(q.staffId)) throw notFound();
  const params: unknown[] = [range.from, range.to, ctx.actor.staffId];
  const zone = branchScopeSql('s.branch_id', scopeFilter(ctx, 'shift.view'), params);
  let where = `s.local_date BETWEEN $1::date AND $2::date AND (s.staff_id = $3 OR ${zone})`;
  if (branchIds.length > 0) {
    params.push(branchIds);
    where += ` AND s.branch_id = ANY($${params.length}::uuid[])`;
  }
  if (q.staffId) {
    params.push(q.staffId);
    where += ` AND s.staff_id = $${params.length}`;
  }
  if (q.status) {
    params.push(q.status);
    where += ` AND s.status = $${params.length}`;
  }
  const r = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE ${where} ORDER BY lower(s.period), s.id LIMIT 2000`, params);
  return { items: await withNames(db, (await shiftDtos(db, r.rows, clock)).map((d) => maskShift(ctx, d))) };
}

interface ChangeRow {
  id: string;
  shift_id: string;
  changed_by: string;
  changed_at: Date;
  kind: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  acknowledged_at: Date | null;
}

/** №308: чужие правки своих смен; это и есть уведомление сотрудника в Э3 (K18 §4). */
async function myChanges(db: Db, ctx: AccessContext, unread: boolean) {
  const r = await db.query<ChangeRow>(
    `SELECT c.id::text AS id, c.shift_id, c.changed_by, c.changed_at, c.kind, c.before, c.after, c.reason, a.acknowledged_at
       FROM journal.staff_shift_changes c JOIN app.staff_shifts s ON s.id = c.shift_id
       LEFT JOIN app.staff_shift_change_acks a ON a.change_id = c.id
      WHERE s.staff_id = $1 AND ($2::boolean = false OR a.change_id IS NULL)
      ORDER BY c.id DESC LIMIT 200`,
    [ctx.actor.staffId, unread],
  );
  return {
    items: r.rows.map((c) => ({
      id: c.id,
      shiftId: c.shift_id,
      changedBy: c.changed_by,
      changedAt: c.changed_at.toISOString(),
      kind: c.kind,
      before: c.before,
      after: c.after,
      reason: c.reason,
      acknowledgedAt: c.acknowledged_at?.toISOString() ?? null,
    })),
  };
}

async function acknowledge(tx: Tx, ctx: AccessContext, changeId: string, meta: AuditRequestMeta, clock: Clock) {
  if (!/^\d{1,18}$/.test(changeId)) throw notFound();
  const own = await tx.query<{ shift_id: string; branch_id: string }>(
    `SELECT c.shift_id, s.branch_id FROM journal.staff_shift_changes c JOIN app.staff_shifts s ON s.id = c.shift_id WHERE c.id = $1::bigint AND s.staff_id = $2`,
    [changeId, ctx.actor.staffId],
  );
  const row = own.rows[0];
  if (!row) throw notFound();
  const now = clock.now();
  const done = await tx.query(`INSERT INTO app.staff_shift_change_acks (change_id, acknowledged_at) VALUES ($1::bigint, $2) ON CONFLICT DO NOTHING`, [changeId, now]);
  if (done.rowCount === 1) {
    await writeAudit(tx, meta, { action: 'shift.change_acknowledged', object: { type: 'shift', id: row.shift_id }, branchId: row.branch_id, after: { changeId } }, clock);
  }
  return { id: changeId, acknowledgedAt: now.toISOString() };
}

/** Ставки сотрудника видны с payroll.view на филиал его назначения; Владелец – всегда; вне зоны – 404 (K18 №309). */
async function assertStaffPayrollView(db: Db, ctx: AccessContext, staffId: string): Promise<void> {
  if (!isUuid(staffId)) throw notFound();
  const target = await staffTargets(db, staffId);
  if (!target) throw notFound();
  if (ctx.network) return assertCan(ctx, 'payroll.view', { network: true });
  const zone = target.branchIds.find((b) => can(ctx, 'payroll.view', { branchId: b })) ?? target.branchIds.find((b) => ctx.branchIds.has(b));
  if (!zone) throw notFound();
  assertCan(ctx, 'payroll.view', { branchId: zone });
}

export async function shiftsCrmRoutes(app: FastifyInstance, deps: ShiftsCrmDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;

  function command(operation: string, denied: { action: AuditAction; type: AuditObjectType }, run: Command, status = 200) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { access, meta } = await deps.authenticate(request, reply);
      const key = requireIdempotencyKey(request.headers['idempotency-key']);
      const params = request.params as Record<string, string>;
      const body = objectBody(request.body);
      const client = await deps.pool.connect();
      let result;
      try {
        await client.query('BEGIN');
        result = await runIdempotent(
          client,
          {
            scope: idempotencyScope('staff', access.actor.staffId, `shifts.${operation}`),
            key,
            request: { route: `${request.method} ${request.routeOptions.url}`, params, body },
            clock,
          },
          async () => ({ status, body: await run(client, access, params, body, meta, clock) }),
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err instanceof AppError && err.code === 'FORBIDDEN') {
          await writeDenied(deps.pool, meta, { action: denied.action, object: { type: denied.type, id: params.id ?? null }, reason: `FORBIDDEN: ${String(err.details?.action ?? '')}`, result: 'denied' }, clock);
        }
        throw err;
      } finally {
        client.release();
      }
      if (result.replayed) reply.header('idempotent-replay', 'true');
      return reply.code(result.status).send(result.body);
    };
  }
  const shiftAudit = (action: AuditAction) => ({ action, type: 'shift' as const });

  // №301
  app.get('/shifts', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    return reply.send(await listShifts(deps.pool, access, request.query, clock));
  });
  // №307 (статический путь – раньше /shifts/:id)
  app.get('/shifts/coverage', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const q = request.query as Record<string, string | undefined>;
    return reply.send(await coverage(deps.pool, access, { branchIds: (q.branchIds ?? '').split(',').filter(Boolean), from: q.from ?? '', to: q.to ?? '' }));
  });
  // Карточка смены: чужая и вне зоны – 404 (TC-16)
  app.get('/shifts/:id', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const dto = await getShift(deps.pool, (request.params as { id: string }).id, clock);
    if (!dto || !canSee(access, dto)) throw notFound();
    return reply.send((await withNames(deps.pool, [maskShift(access, dto)]))[0]);
  });
  // №302–304
  app.post('/shifts', command('create', { action: 'shift.created', type: 'shift' }, async (tx, ctx, _p, body, meta, c) => maskShift(ctx, await createShift(tx, ctx, body, meta, c)), 201));
  app.patch('/shifts/:id', command('update', shiftAudit('shift.updated'), async (tx, ctx, p, body, meta, c) => maskShift(ctx, await updateShift(tx, ctx, p.id!, body, meta, c))));
  app.post('/shifts/:id/cancel', command('cancel', shiftAudit('shift.cancelled'), async (tx, ctx, p, body, meta, c) => maskShift(ctx, await cancelShift(tx, ctx, p.id!, body, meta, c))));
  // №305
  app.post('/shifts/:id/check-in', command('check_in', shiftAudit('shift.attendance_set'), async (tx, ctx, p, _b, meta, c) => maskShift(ctx, await checkIn(tx, ctx, p.id!, meta, c))));
  app.post('/shifts/:id/check-out', command('check_out', shiftAudit('shift.attendance_set'), async (tx, ctx, p, _b, meta, c) => maskShift(ctx, await checkOut(tx, ctx, p.id!, meta, c))));
  // №306
  app.post('/shifts/:id/attendance', command('attendance', shiftAudit('shift.attendance_set'), async (tx, ctx, p, body, meta, c) => maskShift(ctx, await setAttendance(tx, ctx, p.id!, body, meta, c))));
  // №308
  app.get('/me/shift-changes', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    if (!roleAllows(access.role, 'shift.view.own')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'shift.view.own' });
    return reply.send(await myChanges(deps.pool, access, (request.query as { unread?: string }).unread === 'true'));
  });
  app.post('/me/shift-changes/:id/ack', command('ack', { action: 'shift.change_acknowledged', type: 'shift' }, async (tx, ctx, p, _b, meta, c) => acknowledge(tx, ctx, p.id!, meta, c)));
  // №309
  app.get('/staff/:id/rates', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const id = (request.params as { id: string }).id;
    await assertStaffPayrollView(deps.pool, access, id);
    return reply.send({ items: await listRates(deps.pool, id) });
  });
  app.post(
    '/staff/:id/rates',
    command(
      'rate.set',
      { action: 'staff.rate_set', type: 'staff_rate' },
      async (tx, ctx, p, body, meta, c) =>
        setRate(
          tx,
          ctx,
          {
            staffId: p.id!,
            validFrom: String(body.validFrom ?? ''),
            hourlyKop: body.hourlyKop as number,
            attendanceFeeKop: body.attendanceFeeKop as number,
            reason: String(body.reason ?? ''),
            corrects: (body.corrects as string | null | undefined) ?? null,
          },
          meta,
          c,
        ),
      201,
    ),
  );
  // №310
  app.patch(
    '/staff/:id/planning',
    command('planning', { action: 'staff.planning_changed', type: 'staff' }, async (tx, ctx, p, body, meta, c) => {
      const res = await setPlanningStatus(tx, ctx, p.id!, body, meta, c);
      return { ...res, futureShiftsNeedingDecision: res.futureShiftsNeedingDecision.map((d) => maskShift(ctx, d)) };
    }),
  );
  // №319
  app.patch('/staff/:id/employment', command('employment', { action: 'staff.employment_changed', type: 'staff' }, async (tx, ctx, p, body, meta, c) => setEmployment(tx, ctx, p.id!, body, meta, c)));
}
