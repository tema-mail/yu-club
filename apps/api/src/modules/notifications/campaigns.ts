// K21 §4–§6: кампания – любое ручное сообщение, даже одному клиенту. draft → confirmed → expanding → sending → done; отмена.
// Права (K21 §10): по категории и типу аудитории; роль проверяется раньше зоны – Администратору на рекламу и сегмент всегда 403.
// Сервисное – только с привязкой к брони клиента (K21 §4, «сервисное не используется как реклама»); на сегмент запрещено.
// Подтверждение: двойное для сегмента (expectedTotal, 09 §7.5), реклама – только с erid при marketing_require_erid (умолчание до
// ответа Q-130/Q-148) и при заданном UNSUBSCRIBE_SECRET; снимок получателей – в журнал, строки создаёт campaign-runner.ts.
// Текст после подтверждения неизменен: держит триггер 0402 (09 §14). В аудит текст уходит один раз – шаблоном, без подстановки.
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { idempotencyScope, runIdempotent, type IdempotentResult } from '../../core/idempotency.ts';
import { roleAllows, type AccessContext, type NetworkLookup } from '../../core/permissions.ts';
import { resolveSettings } from '../../core/settings.ts';
import type { Clock } from '../../core/time.ts';
import { withTx, type Pool } from '../clients/index.ts';
import { decideSend, type SendDecision } from './index.ts';
import { parseSegment, previewSegment, resolveArea, segmentRecipients, type AudiencePreview, type ResolvedArea, type SegmentRecipient } from './segments.ts';
import { activeTemplate, assertPlaceholders } from './templates.ts';

export type CampaignCategory = 'service' | 'marketing';
export type CampaignStatus = 'draft' | 'confirmed' | 'expanding' | 'sending' | 'done' | 'cancelled';

export type Audience =
  | { kind: 'client'; clientId: string; bookingId?: string | undefined; branchId?: string | undefined }
  | { kind: 'booking'; bookingId: string }
  | { kind: 'segment'; segment: unknown };

/** Факты брони у booking (реализация – booking/providers.ts bookingLookup.facts). */
export interface CampaignBookingLookup {
  facts(db: Db, bookingId: string): Promise<{ clientId: string; branchId: string; bookingVersion: number } | null>;
}

export interface CampaignDeps {
  pool: Pool;
  clock: Clock;
  network: NetworkLookup;
  bookings: CampaignBookingLookup;
  /** UNSUBSCRIBE_SECRET: без него рекламу нельзя подтвердить (K21 §13, MARKETING_NOT_CONFIGURED). */
  unsubscribeSecret: string | null;
}

export interface CampaignInput {
  purpose?: string | undefined;
  category?: CampaignCategory | undefined;
  title?: string | undefined;
  body?: string | undefined;
  url?: string | null | undefined;
  audience: Audience;
  plannedAt?: string | null | undefined;
  templateId?: string | undefined;
  push?: boolean | undefined;
  advertiserNote?: string | null | undefined;
  erid?: string | null | undefined;
}

export interface CampaignDto {
  id: string;
  status: CampaignStatus;
  purpose: string | null;
  category: CampaignCategory;
  title: string;
  body: string;
  url: string | null;
  push: boolean;
  audience: Audience;
  areaType: 'network' | 'city' | 'branch';
  areaIds: string[];
  plannedAt: string | null;
  advertiserNote: string | null;
  erid: string | null;
  templateId: string | null;
  previewSnapshot: AudiencePreview | null;
  previewAt: string | null;
  total: number | null;
  createdBy: string;
  createdAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  cancelledReason: string | null;
  rowVersion: number;
}

export interface CampaignRow {
  id: string;
  status: CampaignStatus;
  purpose: string | null;
  category: CampaignCategory;
  title: string;
  body: string;
  url: string | null;
  push: boolean;
  audience: Audience;
  area_type: 'network' | 'city' | 'branch';
  area_ids: string[];
  planned_at: Date | null;
  advertiser_note: string | null;
  erid: string | null;
  template_id: string | null;
  preview_snapshot: AudiencePreview | null;
  preview_at: Date | null;
  total: number | null;
  created_by: string;
  created_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  cancelled_reason: string | null;
  row_version: number;
}

export function campaignDto(r: CampaignRow): CampaignDto {
  return {
    id: r.id,
    status: r.status,
    purpose: r.purpose,
    category: r.category,
    title: r.title,
    body: r.body,
    url: r.url,
    push: r.push,
    audience: r.audience,
    areaType: r.area_type,
    areaIds: r.area_ids,
    plannedAt: r.planned_at?.toISOString() ?? null,
    advertiserNote: r.advertiser_note,
    erid: r.erid,
    templateId: r.template_id,
    previewSnapshot: r.preview_snapshot,
    previewAt: r.preview_at?.toISOString() ?? null,
    total: r.total,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at?.toISOString() ?? null,
    cancelledReason: r.cancelled_reason,
    rowVersion: r.row_version,
  };
}

const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');
const forbidden = (action: string) => new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action });

/** Роль на категорию и тип аудитории: Администратору реклама и сегмент – 403 независимо от зоны. */
export function assertSendRole(ctx: AccessContext, category: CampaignCategory, audience: Audience): void {
  const action = category === 'marketing' ? 'notifications.send.marketing' : 'notifications.send.service';
  if (!roleAllows(ctx.role, action)) throw forbidden(action);
  if (audience.kind === 'segment' && !roleAllows(ctx.role, 'notifications.send.mass')) throw forbidden('notifications.send.mass');
}

export function inZone(ctx: AccessContext, branchId: string): boolean {
  return ctx.network || ctx.branchIds.has(branchId);
}

interface ResolvedAudience {
  area: ResolvedArea;
  /** Клиент адресного сообщения (null – сегмент). */
  clientId: string | null;
  bookingId: string | null;
  bookingVersion: number | null;
}

/** Проверка аудитории и зоны. Чужая бронь, клиент или филиал → NOT_FOUND (K1). */
async function resolveAudience(db: Db, deps: CampaignDeps, ctx: AccessContext, category: CampaignCategory, audience: Audience): Promise<ResolvedAudience> {
  if (audience.kind === 'segment') {
    if (category === 'service') throw new AppError('SEGMENT_SERVICE_FORBIDDEN', 422, 'Сервисное сообщение нельзя отправить на сегмент');
    const segment = parseSegment(audience.segment);
    return { area: await resolveArea(db, ctx, segment.area, deps.network), clientId: null, bookingId: null, bookingVersion: null };
  }
  const bookingId = audience.bookingId;
  if (bookingId) {
    const b = await deps.bookings.facts(db, bookingId);
    if (!b || !inZone(ctx, b.branchId)) throw notFound();
    if (audience.kind === 'client' && audience.clientId !== b.clientId) throw notFound();
    return { area: { type: 'branch', ids: [b.branchId], branchIds: [b.branchId] }, clientId: b.clientId, bookingId, bookingVersion: b.bookingVersion };
  }
  if (audience.kind !== 'client') throw notFound();
  if (category === 'service') throw new AppError('SERVICE_NEEDS_SUBJECT', 422, 'Сервисное сообщение – только с привязкой к записи клиента');
  const exists = await db.query(`SELECT 1 FROM app.clients WHERE id = $1 AND status <> 'anonymized'`, [audience.clientId]);
  if (!exists.rowCount) throw notFound();
  if (!audience.branchId) {
    if (!ctx.network) throw notFound(); // клиент один на сеть: не-Владелец обязан назвать свой филиал, где клиент бывал
    return { area: { type: 'network', ids: [], branchIds: null }, clientId: audience.clientId, bookingId: null, bookingVersion: null };
  }
  if (!inZone(ctx, audience.branchId)) throw notFound();
  const linked = await db.query('SELECT 1 FROM app.bookings WHERE client_id = $1 AND branch_id = $2 LIMIT 1', [audience.clientId, audience.branchId]);
  if (!linked.rowCount) throw notFound();
  return { area: { type: 'branch', ids: [audience.branchId], branchIds: [audience.branchId] }, clientId: audience.clientId, bookingId: null, bookingVersion: null };
}

async function assertPlannedAt(db: Db, plannedAt: string | null | undefined, now: Date): Promise<Date | null> {
  if (!plannedAt) return null;
  const at = new Date(plannedAt);
  const days = (await resolveSettings(db, ['notifications.campaign_max_plan_days'], { network: true }, now))['notifications.campaign_max_plan_days'].value;
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() || at.getTime() > now.getTime() + days * 86_400_000) {
    throw new AppError('PLANNED_AT_OUT_OF_RANGE', 422, 'Плановая дата вне допустимого диапазона', { maxDays: days });
  }
  return at;
}

const COLUMNS = `id, status, purpose, category, title, body, url, push, audience, area_type, area_ids, planned_at, advertiser_note, erid, template_id,
  preview_snapshot, preview_at, total, created_by, created_at, confirmed_by, confirmed_at, cancelled_reason, row_version`;

async function loadInZone(db: Db, ctx: AccessContext, id: string, lock = false): Promise<CampaignRow> {
  const r = await db.query<CampaignRow>(`SELECT ${COLUMNS} FROM app.notification_campaigns WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  const c = r.rows[0];
  if (!c || !campaignInZone(ctx, c)) throw notFound();
  return c;
}

/** Кампания в зоне: сетевую видит только Владелец; городскую и филиальную – по пересечению с зоной. */
export function campaignInZone(ctx: AccessContext, c: Pick<CampaignRow, 'area_type' | 'area_ids'>): boolean {
  if (ctx.network) return true;
  if (c.area_type === 'network') return false;
  if (c.area_type === 'city') return c.area_ids.every((x) => ctx.cityIds.has(x));
  return c.area_ids.every((x) => ctx.branchIds.has(x));
}

export async function getCampaign(db: Db, ctx: AccessContext, id: string): Promise<CampaignDto> {
  return campaignDto(await loadInZone(db, ctx, id));
}

function validateText(input: { category?: CampaignCategory | undefined; title?: string | undefined; body?: string | undefined; purpose?: string | undefined }, audience: Audience): asserts input is { category: CampaignCategory; title: string; body: string; purpose?: string | undefined } {
  if (!input.category) throw new AppError('CATEGORY_REQUIRED', 422, 'Укажите категорию сообщения');
  if (audience.kind !== 'segment' && !input.purpose?.trim()) throw new AppError('CATEGORY_REQUIRED', 422, 'Укажите назначение личного сообщения', { field: 'purpose' });
  if (!input.title?.trim() || !input.body?.trim()) throw new AppError('VALIDATION_FAILED', 400, 'Нужны заголовок и текст', { fields: ['title', 'body'] });
  assertPlaceholders(input.title, input.body);
}

export const CAMPAIGN_CREATE_ROUTE = 'POST /api/crm/v1/notifications/campaigns';
export const CAMPAIGN_CONFIRM_ROUTE = 'POST /api/crm/v1/notifications/campaigns/:id/confirm';
export const CAMPAIGN_CANCEL_ROUTE = 'POST /api/crm/v1/notifications/campaigns/:id/cancel';

/** Черновик (K11 №202). Шаблон копируется: правка шаблона эту кампанию не изменит. */
export async function createCampaign(deps: CampaignDeps, ctx: AccessContext, meta: AuditRequestMeta, input: CampaignInput, key: string): Promise<IdempotentResult> {
  const { clock } = deps;
  return withTx(deps.pool, (tx) =>
    runIdempotent(tx, { scope: idempotencyScope('staff', ctx.actor.staffId, CAMPAIGN_CREATE_ROUTE), key, request: { route: CAMPAIGN_CREATE_ROUTE, body: input }, clock }, async () => {
      const now = clock.now();
      const tpl = input.templateId ? await activeTemplate(tx, input.templateId) : null;
      const text = { category: input.category ?? tpl?.category, title: input.title ?? tpl?.title, body: input.body ?? tpl?.body, purpose: input.purpose };
      validateText(text, input.audience);
      assertSendRole(ctx, text.category, input.audience);
      const a = await resolveAudience(tx, deps, ctx, text.category, input.audience);
      const plannedAt = await assertPlannedAt(tx, input.plannedAt, now);
      const r = await tx.query<CampaignRow>(
        `INSERT INTO app.notification_campaigns (purpose, category, title, body, url, push, audience, area_type, area_ids, planned_at, advertiser_note, erid, template_id, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11, $12, $13, $14, $15, $15) RETURNING ${COLUMNS}`,
        [text.purpose ?? null, text.category, text.title, text.body, input.url ?? null, input.push ?? true, JSON.stringify(input.audience), a.area.type, a.area.ids, plannedAt, input.advertiserNote ?? null, input.erid ?? null, input.templateId ?? null, ctx.actor.staffId, now],
      );
      const row = r.rows[0]!;
      await writeAudit(tx, meta, { action: 'notification.campaign_created', object: { type: 'notification_campaign', id: row.id }, after: { category: row.category, audienceKind: input.audience.kind, areaType: a.area.type } }, clock);
      return { status: 201, body: campaignDto(row) };
    }),
  );
}

/** Правка черновика (K11 №204): только draft и актуальная row_version. */
export async function updateCampaign(deps: CampaignDeps, ctx: AccessContext, meta: AuditRequestMeta, id: string, patch: Partial<CampaignInput> & { rowVersion: number }): Promise<CampaignDto> {
  const { clock } = deps;
  return withTx(deps.pool, async (tx) => {
    const cur = await loadInZone(tx, ctx, id, true);
    if (cur.status !== 'draft') throw new AppError('CAMPAIGN_NOT_EDITABLE', 409, 'Править можно только черновик');
    if (cur.row_version !== patch.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Кампания уже изменена', { rowVersion: cur.row_version });
    const audience = patch.audience ?? cur.audience;
    const text = { category: patch.category ?? cur.category, title: patch.title ?? cur.title, body: patch.body ?? cur.body, purpose: patch.purpose ?? cur.purpose ?? undefined };
    validateText(text, audience);
    assertSendRole(ctx, text.category, audience);
    const a = await resolveAudience(tx, deps, ctx, text.category, audience);
    const plannedAt = patch.plannedAt === undefined ? cur.planned_at : await assertPlannedAt(tx, patch.plannedAt, clock.now());
    const r = await tx.query<CampaignRow>(
      `UPDATE app.notification_campaigns SET purpose = $2, category = $3, title = $4, body = $5, url = $6, push = $7, audience = $8, area_type = $9, area_ids = $10::uuid[], planned_at = $11,
         advertiser_note = $12, erid = $13, preview_snapshot = NULL, preview_at = NULL, row_version = row_version + 1, updated_at = $14 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, text.purpose ?? null, text.category, text.title, text.body, patch.url === undefined ? cur.url : patch.url, patch.push ?? cur.push, JSON.stringify(audience), a.area.type, a.area.ids, plannedAt,
        patch.advertiserNote === undefined ? cur.advertiser_note : patch.advertiserNote, patch.erid === undefined ? cur.erid : patch.erid, clock.now()],
    );
    await writeAudit(tx, meta, { action: 'notification.campaign_updated', object: { type: 'notification_campaign', id }, after: { category: text.category, audienceKind: audience.kind } }, clock);
    return campaignDto(r.rows[0]!);
  });
}

function singlePreview(d: SendDecision, category: CampaignCategory, push: boolean, now: Date): AudiencePreview {
  const reason = !d.ok && 'reason' in d ? d.reason : null;
  const passes = d.ok || d.status === 'no_channel';
  return {
    total: 1,
    willReceivePush: d.ok && push ? 1 : 0,
    inboxOnly: passes && !(d.ok && push) ? 1 : 0,
    excludedMarketingOff: reason === 'marketing_off' || reason === 'no_marketing_consent' ? 1 : 0,
    excludedFrequency: reason === 'min_interval' ? 1 : 0,
    excludedInactive: reason === 'client_inactive' ? 1 : 0,
    criticalService: category === 'service' && passes ? 1 : 0,
    sample: [],
    computedAt: now.toISOString(),
  };
}

/** Предпросмотр (K11 №205, K21 §5): результат запоминается в кампании. */
export async function previewCampaign(deps: CampaignDeps, ctx: AccessContext, id: string): Promise<AudiencePreview> {
  const now = deps.clock.now();
  const c = await loadInZone(deps.pool, ctx, id);
  assertSendRole(ctx, c.category, c.audience);
  let preview: AudiencePreview;
  if (c.audience.kind === 'segment') {
    const segment = parseSegment(c.audience.segment);
    preview = await previewSegment(deps.pool, ctx, segment, await resolveArea(deps.pool, ctx, segment.area, deps.network), c.push, now);
  } else {
    const a = await resolveAudience(deps.pool, deps, ctx, c.category, c.audience);
    preview = singlePreview(await decideSend(deps.pool, { clientId: a.clientId!, category: c.category, push: c.push }, now), c.category, c.push, now);
  }
  await deps.pool.query('UPDATE app.notification_campaigns SET preview_snapshot = $2, preview_at = $3 WHERE id = $1', [id, JSON.stringify(preview), now]);
  return preview;
}

async function homeBranch(db: Db, clientId: string, area: ResolvedArea): Promise<string | null> {
  const r = await db.query<{ id: string | null }>(
    `SELECT coalesce(
       (SELECT v.branch_id FROM app.visits v WHERE v.client_id = $1 AND v.status = 'active' AND ($2::uuid[] IS NULL OR v.branch_id = ANY($2::uuid[])) ORDER BY v.arrived_at DESC, v.id LIMIT 1),
       (SELECT bk.branch_id FROM app.bookings bk WHERE bk.client_id = $1 AND ($2::uuid[] IS NULL OR bk.branch_id = ANY($2::uuid[])) ORDER BY lower(bk.period) DESC, bk.id LIMIT 1),
       (SELECT b.id FROM app.branches b WHERE ($2::uuid[] IS NULL OR b.id = ANY($2::uuid[])) ORDER BY b.sort_order, b.id LIMIT 1)) AS id`,
    [clientId, area.branchIds],
  );
  return r.rows[0]?.id ?? null;
}

function decisionText(d: SendDecision): string {
  if (d.ok) return 'ok';
  return 'reason' in d ? d.reason : d.status;
}

/** Решения, при которых строка создаётся (снимок): остальные исключены на момент подтверждения. */
export const RECIPIENT_PASSES: ReadonlySet<string> = new Set(['ok', 'no_channel']);

/**
 * Подтверждение (K11 №206): двойное для сегмента и total > 1 (09 §7.5). Параллельные подтверждения сериализует FOR UPDATE;
 * повтор с тем же ключом – та же кампания (runIdempotent), с другим ключом – CAMPAIGN_NOT_EDITABLE.
 */
export async function confirmCampaign(deps: CampaignDeps, ctx: AccessContext, meta: AuditRequestMeta, id: string, input: { rowVersion: number; expectedTotal?: number | undefined }, key: string): Promise<IdempotentResult> {
  const { clock } = deps;
  return withTx(deps.pool, (tx) =>
    runIdempotent(tx, { scope: idempotencyScope('staff', ctx.actor.staffId, CAMPAIGN_CONFIRM_ROUTE), key, request: { route: CAMPAIGN_CONFIRM_ROUTE, params: { id }, body: input }, clock }, async () => {
      const now = clock.now();
      const c = await loadInZone(tx, ctx, id, true);
      assertSendRole(ctx, c.category, c.audience);
      if (c.status !== 'draft') throw new AppError('CAMPAIGN_NOT_EDITABLE', 409, 'Кампания уже подтверждена или отменена');
      if (c.row_version !== input.rowVersion) throw new AppError('VERSION_CONFLICT', 409, 'Кампания уже изменена', { rowVersion: c.row_version });
      if (c.category === 'marketing') {
        if (!deps.unsubscribeSecret) throw new AppError('MARKETING_NOT_CONFIGURED', 503, 'Рассылка рекламы не настроена: нет ключа отписки');
        const requireErid = (await resolveSettings(tx, ['notifications.marketing_require_erid'], { network: true }, now))['notifications.marketing_require_erid'].value;
        if (requireErid && !c.erid) throw new AppError('MARKETING_ERID_REQUIRED', 422, 'Для рекламы нужен идентификатор erid');
      }
      const a = await resolveAudience(tx, deps, ctx, c.category, c.audience);
      const recipients: SegmentRecipient[] =
        c.audience.kind === 'segment'
          ? await segmentRecipients(tx, parseSegment(c.audience.segment), a.area, c.push, now)
          : [{ clientId: a.clientId!, homeBranchId: await homeBranch(tx, a.clientId!, a.area), decision: decisionText(await decideSend(tx, { clientId: a.clientId!, category: c.category, push: c.push }, now)) }];
      const total = recipients.length;
      if (total === 0) throw new AppError('AUDIENCE_EMPTY', 422, 'В аудитории никого нет');
      if ((c.audience.kind === 'segment' || total > 1) && input.expectedTotal !== total) {
        throw new AppError('AUDIENCE_CHANGED', 409, 'Аудитория изменилась, проверьте число получателей', { total });
      }
      await tx.query(
        `INSERT INTO journal.notification_campaign_recipients (campaign_id, client_id, home_branch_id, decision, created_at)
         SELECT $1, x.client_id, x.home, x.decision, $5 FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS x(client_id, home, decision)`,
        [id, recipients.map((r) => r.clientId), recipients.map((r) => r.homeBranchId), recipients.map((r) => r.decision), now],
      );
      const r = await tx.query<CampaignRow>(
        `UPDATE app.notification_campaigns SET status = 'confirmed', confirmed_by = $2, confirmed_at = $3, total = $4, row_version = row_version + 1, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, ctx.actor.staffId, now, total],
      );
      await writeAudit(
        tx,
        meta,
        // текст – шаблоном, без подстановки имени (K21 §15); состав – в журнале получателей
        { action: 'notification.campaign_confirmed', object: { type: 'notification_campaign', id }, after: { category: c.category, title: c.title, body: c.body, audienceKind: c.audience.kind, areaType: c.area_type, total } },
        clock,
      );
      return { status: 200, body: campaignDto(r.rows[0]!) };
    }),
  );
}

/** Отмена (K11 №207): неотправленные строки → cancelled, ушедшее не отзывается; причина обязательна. */
export async function cancelCampaign(deps: CampaignDeps, ctx: AccessContext, meta: AuditRequestMeta, id: string, input: { reason: string }, key: string): Promise<IdempotentResult> {
  const { clock } = deps;
  const reason = input.reason?.trim();
  if (!reason) throw new AppError('VALIDATION_FAILED', 400, 'Укажите причину отмены', { field: 'reason' });
  return withTx(deps.pool, (tx) =>
    runIdempotent(tx, { scope: idempotencyScope('staff', ctx.actor.staffId, CAMPAIGN_CANCEL_ROUTE), key, request: { route: CAMPAIGN_CANCEL_ROUTE, params: { id }, body: input }, clock }, async () => {
      const now = clock.now();
      const c = await loadInZone(tx, ctx, id, true);
      assertSendRole(ctx, c.category, c.audience);
      if (c.status === 'done' || c.status === 'cancelled') throw new AppError('CAMPAIGN_ALREADY_FINISHED', 409, 'Кампания уже завершена');
      const cancelled = await tx.query(`UPDATE app.notifications SET status = 'cancelled', skip_reason = 'campaign_cancelled', updated_at = $2 WHERE campaign_id = $1 AND status IN ('planned','queued')`, [id, now]);
      const r = await tx.query<CampaignRow>(
        `UPDATE app.notification_campaigns SET status = 'cancelled', cancelled_reason = $2, row_version = row_version + 1, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, reason, now],
      );
      await writeAudit(tx, meta, { action: 'notification.campaign_cancelled', object: { type: 'notification_campaign', id }, reason, after: { rowsCancelled: cancelled.rowCount ?? 0 } }, clock);
      return { status: 200, body: campaignDto(r.rows[0]!) };
    }),
  );
}
