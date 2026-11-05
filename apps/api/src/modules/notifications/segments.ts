// K21 §5: сегменты segment.v1 → SQL в пределах зоны отправителя (K1 scopeFilter), домашний филиал, предпросмотр аудитории.
// «Клиенты филиала» = клиенты с хотя бы одной бронью (любого статуса; удержания – отдельная таблица) в филиалах области
// за всё время (решение K21 §5). Домашний филиал для тихих часов: последнее посещение в области, иначе последняя бронь,
// иначе первый филиал области по sort_order.
// Брони и посещения принадлежат booking, филиалы – network: здесь только чтение (как отчёты читают rpt_*; представлений
// rpt_bookings/rpt_visits до 0406 нет – при их появлении запрос переходит на них, смысл не меняется).
// Даты условий – LocalDate по зоне филиала посещения (K8); registeredBetween – по зоне первого филиала области.
// Предпросмотр – одним запросом в READ ONLY транзакции; классификация повторяет decideSend (index.ts) для рекламы.
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, type AccessContext, type NetworkLookup } from '../../core/permissions.ts';
import { resolveSetting } from '../../core/settings.ts';
import { withTx, type Pool } from '../clients/index.ts';

const LOCAL_DATE = z.iso.date();
const range = z.object({ from: LOCAL_DATE, to: LOCAL_DATE }).refine((r) => r.from <= r.to, { message: 'from позже to' });
const ids = z.array(z.uuid()).min(1).max(200);

export const segmentV1 = z
  .object({
    v: z.literal(1),
    area: z.union([z.object({ network: z.literal(true) }).strict(), z.object({ cityIds: ids }).strict(), z.object({ branchIds: ids }).strict()]),
    visitedBetween: range.optional(),
    notVisitedSince: LOCAL_DATE.optional(),
    minVisits: z.number().int().min(1).max(1000).optional(),
    hasUpcomingBooking: z.boolean().optional(),
    resourceTypes: z.array(z.enum(['pc', 'vr', 'ps'])).min(1).max(3).optional(),
    registeredBetween: range.optional(),
  })
  .strict();

export type SegmentV1 = z.infer<typeof segmentV1>;

/** Направление сегмента → коды справочника типов ресурсов (0010). Составная конфигурация и «комната целиком» не
 *  относятся к одному направлению – в условие не входят (решение; уточняется вместе с Q-131). */
export const DIRECTION_TYPES: Record<'pc' | 'vr' | 'ps', string[]> = { pc: ['pc'], vr: ['vr_seat'], ps: ['ps_room'] };

export function parseSegment(input: unknown): SegmentV1 {
  const r = segmentV1.safeParse(input);
  if (!r.success) {
    throw new AppError('SEGMENT_INVALID', 422, 'Сегмент задан неверно', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

/** Область сегмента в филиалах. null – вся сеть. Чужой филиал или город → NOT_FOUND (K1), сеть не у Владельца → FORBIDDEN. */
export interface ResolvedArea {
  type: 'network' | 'city' | 'branch';
  ids: string[];
  branchIds: string[] | null;
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

export async function resolveArea(db: Db, ctx: AccessContext, area: SegmentV1['area'], network: NetworkLookup): Promise<ResolvedArea> {
  if ('network' in area) {
    if (!ctx.network) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'notifications.send.mass' });
    return { type: 'network', ids: [], branchIds: null };
  }
  if ('cityIds' in area) {
    const cities = [...new Set(area.cityIds)].sort();
    if (!ctx.network && cities.some((c) => !ctx.cityIds.has(c))) throw notFound();
    const branches = await network.branchesOfCities(db, cities);
    if (branches.length === 0) throw new AppError('SEGMENT_INVALID', 422, 'В области нет филиалов', { issues: [{ path: 'area', message: 'empty' }] });
    return { type: 'city', ids: cities, branchIds: [...new Set(branches)].sort() };
  }
  const branches = [...new Set(area.branchIds)].sort();
  if (!ctx.network && branches.some((b) => !ctx.branchIds.has(b))) throw notFound();
  const known = await db.query<{ id: string }>('SELECT id FROM app.branches WHERE id = ANY($1::uuid[])', [branches]);
  if (known.rows.length !== branches.length) throw notFound();
  return { type: 'branch', ids: branches, branchIds: branches };
}

/**
 * CTE «aud» (client_id, home_branch_id) по сегменту. $1 – филиалы области (uuid[] или NULL = сеть), $2 – $now;
 * дальнейшие параметры добавляются в params. Возвращает текст WITH … без завершающего SELECT.
 */
export function audienceCte(s: SegmentV1, params: unknown[]): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const inArea = (col: string) => `($1::uuid[] IS NULL OR ${col} = ANY($1::uuid[]))`;
  const visit = (extra: string) =>
    `EXISTS (SELECT 1 FROM app.visits v JOIN app.branches vb ON vb.id = v.branch_id JOIN app.bookings vk ON vk.id = v.booking_id
       JOIN app.resources vr ON vr.id = vk.resource_id
       WHERE v.client_id = c.id AND v.status = 'active' AND ${inArea('v.branch_id')} ${extra})`;
  const localDay = `(v.arrived_at AT TIME ZONE vb.timezone)::date`;
  const where: string[] = [];
  if (s.visitedBetween) where.push(visit(`AND ${localDay} BETWEEN ${p(s.visitedBetween.from)}::date AND ${p(s.visitedBetween.to)}::date`));
  if (s.notVisitedSince) where.push(`${visit('')} AND NOT ${visit(`AND ${localDay} >= ${p(s.notVisitedSince)}::date`)}`);
  if (s.minVisits !== undefined) {
    where.push(`(SELECT count(*) FROM app.visits v WHERE v.client_id = c.id AND v.status = 'active' AND ${inArea('v.branch_id')}) >= ${p(s.minVisits)}`);
  }
  if (s.hasUpcomingBooking !== undefined) {
    where.push(
      `${s.hasUpcomingBooking ? '' : 'NOT '}EXISTS (SELECT 1 FROM app.bookings ub WHERE ub.client_id = c.id AND ub.status = 'confirmed' AND lower(ub.period) > $2 AND ${inArea('ub.branch_id')})`,
    );
  }
  if (s.resourceTypes) where.push(visit(`AND vr.resource_type = ANY(${p(s.resourceTypes.flatMap((d) => DIRECTION_TYPES[d]))}::text[])`));
  if (s.registeredBetween) {
    const tz = `coalesce((SELECT b.timezone FROM app.branches b WHERE ${inArea('b.id')} ORDER BY b.sort_order, b.id LIMIT 1), 'UTC')`;
    where.push(
      `c.registered_at IS NOT NULL AND (c.registered_at AT TIME ZONE ${tz})::date BETWEEN ${p(s.registeredBetween.from)}::date AND ${p(s.registeredBetween.to)}::date`,
    );
  }
  return `WITH members AS (SELECT DISTINCT bk.client_id FROM app.bookings bk WHERE ${inArea('bk.branch_id')} AND $2::timestamptz IS NOT NULL),
  aud AS (
    SELECT c.id AS client_id, c.status, c.first_name, c.last_name,
      coalesce(
        (SELECT v.branch_id FROM app.visits v WHERE v.client_id = c.id AND v.status = 'active' AND ${inArea('v.branch_id')} ORDER BY v.arrived_at DESC, v.id LIMIT 1),
        (SELECT bk.branch_id FROM app.bookings bk WHERE bk.client_id = c.id AND ${inArea('bk.branch_id')} ORDER BY lower(bk.period) DESC, bk.id LIMIT 1),
        (SELECT b.id FROM app.branches b WHERE ${inArea('b.id')} ORDER BY b.sort_order, b.id LIMIT 1)
      ) AS home_branch_id
    FROM app.clients c JOIN members m ON m.client_id = c.id
    WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
  )`;
}

/** Решение для рекламы одним выражением SQL (как decideSend): $X – начало окна частоты, push – константа. */
function marketingDecisionSql(sinceParam: string, push: boolean): string {
  return `CASE
    WHEN a.status IN ('guest','blocked','deletion_requested','anonymized') THEN 'client_inactive'
    WHEN NOT coalesce((SELECT p.marketing_enabled FROM app.client_notification_prefs p WHERE p.client_id = a.client_id), false) THEN 'marketing_off'
    WHEN coalesce((SELECT cc.granted FROM journal.client_consents cc WHERE cc.client_id = a.client_id AND cc.kind = 'marketing' ORDER BY cc.at DESC, cc.id DESC LIMIT 1), false) IS NOT TRUE
      THEN 'no_marketing_consent'
    WHEN ${sinceParam}::timestamptz IS NOT NULL AND EXISTS (SELECT 1 FROM app.notifications n WHERE n.client_id = a.client_id AND n.category = 'marketing'
      AND ((n.status = 'sent_to_provider' AND n.sent_at > ${sinceParam}) OR (n.status = 'sending' AND n.updated_at > ${sinceParam}))) THEN 'min_interval'
    WHEN ${push ? 'NOT' : 'FALSE AND'} EXISTS (SELECT 1 FROM app.push_subscriptions ps WHERE ps.client_id = a.client_id AND ps.revoked_at IS NULL) THEN 'no_channel'
    ELSE 'ok' END`;
}

export interface AudiencePreview {
  total: number;
  willReceivePush: number;
  inboxOnly: number;
  excludedMarketingOff: number;
  excludedFrequency: number;
  excludedInactive: number;
  criticalService: number;
  sample: Array<{ clientId: string; displayName: string }>;
  computedAt: string;
}

/** Что хранится в кампании: только счётчики. sample (имена) – лишь в ответе предпросмотра с маской по правам смотрящего (K21 §5). */
export type AudienceCounters = Omit<AudiencePreview, 'sample'>;

export interface SegmentRecipient {
  clientId: string;
  homeBranchId: string | null;
  decision: string;
}

/** Маска имени без права client.view.full (K24 §6): «И***». */
export function displayName(first: string | null, last: string | null, full: boolean): string {
  if (full) return [first, last].filter(Boolean).join(' ') || 'Без имени';
  return first ? `${first.slice(0, 1)}***` : 'Без имени';
}

async function frequencySince(db: Db, now: Date): Promise<Date | null> {
  const hours = (await resolveSetting(db, 'notifications.marketing_min_interval_hours', { network: true }, now)).value;
  return hours > 0 ? new Date(now.getTime() - hours * 3600_000) : null;
}

/** Получатели рекламного сегмента с решением на момент (снимок при подтверждении, K21 §5 «Снимок»). */
export async function segmentRecipients(db: Db, s: SegmentV1, area: ResolvedArea, push: boolean, now: Date): Promise<SegmentRecipient[]> {
  const params: unknown[] = [area.branchIds, now];
  const cte = audienceCte(s, params);
  params.push(await frequencySince(db, now));
  const r = await db.query<{ client_id: string; home_branch_id: string | null; decision: string }>(
    `${cte} SELECT a.client_id, a.home_branch_id, ${marketingDecisionSql(`$${params.length}`, push)} AS decision FROM aud a ORDER BY a.client_id`,
    params,
  );
  return r.rows.map((x) => ({ clientId: x.client_id, homeBranchId: x.home_branch_id, decision: x.decision }));
}

/** Предпросмотр рекламного сегмента (09 §7.4): счётчики, сумма = total; принудительной отправки отказавшимся нет. */
export async function previewSegment(pool: Pool, ctx: AccessContext, s: SegmentV1, area: ResolvedArea, push: boolean, now: Date): Promise<AudiencePreview> {
  return withTx(pool, async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    const params: unknown[] = [area.branchIds, now];
    const cte = audienceCte(s, params);
    params.push(await frequencySince(tx, now));
    const r = await tx.query<{ client_id: string; first_name: string | null; last_name: string | null; decision: string }>(
      `${cte} SELECT a.client_id, a.first_name, a.last_name, ${marketingDecisionSql(`$${params.length}`, push)} AS decision FROM aud a ORDER BY a.client_id`,
      params,
    );
    const count = (...d: string[]) => r.rows.filter((x) => d.includes(x.decision)).length;
    const full = roleAllows(ctx.role, 'client.view.full');
    return {
      total: r.rows.length,
      willReceivePush: push ? count('ok') : 0,
      inboxOnly: push ? count('no_channel') : count('ok'),
      excludedMarketingOff: count('marketing_off', 'no_marketing_consent'),
      excludedFrequency: count('min_interval'),
      excludedInactive: count('client_inactive'),
      criticalService: 0,
      sample: r.rows
        .filter((x) => x.decision === 'ok' || x.decision === 'no_channel')
        .slice(0, 10)
        .map((x) => ({ clientId: x.client_id, displayName: displayName(x.first_name, x.last_name, full) })),
      computedAt: now.toISOString(),
    };
  });
}
