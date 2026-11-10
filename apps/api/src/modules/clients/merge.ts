// K9 «Слияние дублей» (03 §11.2, §12, §15; техдолг 5.15): предпросмотр и объединение двух карточек в одной транзакции.
// Основная карточка сохраняется и заполняется из пустого; вторая получает статус merged со ссылкой merged_into_id,
// её ПДн очищаются как при обезличивании (телефон освобождается), сессии и push-подписки отзываются.
// Чужие таблицы (брони, деньги, баллы, сертификаты, мероприятия, уведомления) переносят обработчики модулей
// (registerClientMerger, как registerClientAnonymizer, ADR 0002): регистрирует server.ts при старте, без любого из
// обязательных процедура не запускается (fail closed). Порядок: booking первым (брони и время клиента), затем остальные.
// Строки обеих карточек – FOR UPDATE одним запросом в порядке id (меньший первым): тот же порядок, что lockClients
// у брони и обезличивания, взаимоблокировки нет. Решения, которых нет в K9, – docs/reshenia.md D5-01…D5-08.
import { randomUUID } from 'node:crypto';
import { writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { getClientCard, maskPhone, noBranchLinks, type ClientBranchLinks, type ClientCard, type ClientStatus } from './index.ts';

/** Основание (как D4-61 у обезличивания): только код, свободный текст унёс бы ПДн в журнал. */
export const MERGE_REASONS = ['same_person_confirmed', 'duplicate_registration', 'phone_changed'] as const;
export type MergeReason = (typeof MERGE_REASONS)[number];

export interface MergeContext {
  mergeId: string;
  staffId: string;
  reason: MergeReason;
  now: Date;
}

/** Обработчик модуля-владельца таблиц со ссылкой на клиента. preview – данные для предпросмотра (03 §11.2) без ПДн
 *  других людей; reassign – перенос from → to в транзакции слияния, возвращает итоги числами для журнала. */
export interface ClientMerger {
  name: string;
  preview(db: Db, clientId: string, now: Date): Promise<unknown>;
  reassign(tx: Tx, from: string, to: string, ctx: MergeContext): Promise<Record<string, number>>;
}

/** Порядок вызова: брони и время клиента раньше всего остального (резервы баллов едут за бронями). */
export const REQUIRED_CLIENT_MERGERS = ['booking', 'finance', 'loyalty', 'certificates', 'events', 'notifications'] as const;

const mergers = new Map<string, ClientMerger>();

/** Повторная регистрация того же имени заменяет обработчик (сервер в тестах собирается многократно). */
export function registerClientMerger(m: ClientMerger): void {
  mergers.set(m.name, m);
}

/** Только для тестов. */
export function clearClientMergers(): void {
  mergers.clear();
}

function orderedMergers(): ClientMerger[] {
  const missing = REQUIRED_CLIENT_MERGERS.filter((n) => !mergers.has(n));
  if (missing.length > 0) throw new Error(`mergeClients: не зарегистрирован обработчик модуля ${missing.join(', ')}`);
  const rest = [...mergers.keys()].filter((n) => !(REQUIRED_CLIENT_MERGERS as readonly string[]).includes(n)).sort();
  return [...REQUIRED_CLIENT_MERGERS, ...rest].map((n) => mergers.get(n)!);
}

export interface MergeConflict { field: 'firstName' | 'lastName' | 'phone' | 'email' | 'birthDate' | 'status'; primary: string; secondary: string }
export interface MergeFill { field: 'firstName' | 'lastName' | 'email' | 'birthDate'; value: string }

export interface MergePreview {
  primary: ClientCard;
  secondary: ClientCard;
  /** Данные модулей: { booking: { primary, secondary }, … } – состав решает модуль. */
  modules: Record<string, { primary: unknown; secondary: unknown }>;
  /** Оба значения есть и различаются: останется значение основной (телефон второй освобождается). */
  conflicts: MergeConflict[];
  /** Пустое у основной заполнится из второй. */
  fills: MergeFill[];
  /** Статус основной после слияния (блокировка и ограничение второй переходят). */
  statusAfter: ClientStatus;
  canMerge: boolean;
  /** Почему нельзя (код из CLIENT_NOT_MERGEABLE.details.reason) – при canMerge = false. */
  blocker: string | null;
}

export interface MergeResult {
  mergeId: string;
  primaryId: string;
  secondaryId: string;
  status: 'merged';
  results: Record<string, Record<string, number>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError('NOT_FOUND', 404, 'Не найдено');

interface Row {
  id: string;
  status: ClientStatus;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  birth_date: string | null;
  status_reason: string | null;
  status_until: Date | null;
  registered_at: Date | null;
  merged_into_id: string | null;
}
const ROW_COLS = `id, status, phone_e164, phone_verified_at, first_name, last_name, email, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
  status_reason, status_until, registered_at, merged_into_id`;

function checkIds(primaryId: string, secondaryId: string): void {
  if (!UUID_RE.test(primaryId) || !UUID_RE.test(secondaryId)) throw notFound();
  if (primaryId.toLowerCase() === secondaryId.toLowerCase()) {
    throw new AppError('VALIDATION_FAILED', 400, 'Нужны две разные карточки', { field: 'secondaryId' });
  }
}

/** Статусы, при которых карточка не участвует в слиянии: уже объединена, обезличена, ждёт удаления. */
function assertMergeable(r: Row): void {
  if (r.status === 'merged') throw new AppError('CLIENT_MERGED', 409, 'Карточка уже объединена', { clientId: r.id, mergedIntoId: r.merged_into_id });
  if (r.status === 'anonymized' || r.status === 'deletion_requested') {
    throw new AppError('CLIENT_NOT_MERGEABLE', 409, 'Эту карточку объединять нельзя', { clientId: r.id, status: r.status, reason: r.status });
  }
}

const isRegistered = (r: Row) => r.status !== 'guest' && r.registered_at !== null;

/** Основной должна быть зарегистрированная карточка: иначе клиент потерял бы вход по подтверждённому телефону (решение D5-03). */
function primaryBlocker(p: Row, s: Row): string | null {
  return !isRegistered(p) && isRegistered(s) ? 'primary_must_be_registered' : null;
}

/** Статус основной после слияния: блокировка и ограничение второй не теряются (решение D5-04). */
function statusAfter(p: Row, s: Row): { status: ClientStatus; reason: string | null; until: Date | null } {
  const own = { status: p.status, reason: p.status_reason, until: p.status_until };
  if (p.status === 'blocked') return own;
  if (s.status === 'blocked') return { status: 'blocked', reason: s.status_reason, until: s.status_until };
  if (p.status === 'restricted') return own;
  if (s.status === 'restricted') return { status: 'restricted', reason: s.status_reason, until: s.status_until };
  return own;
}

function diff(p: Row, s: Row): { conflicts: MergeConflict[]; fills: MergeFill[] } {
  const conflicts: MergeConflict[] = [];
  const fills: MergeFill[] = [];
  const fields: Array<[MergeFill['field'], string | null, string | null]> = [
    ['firstName', p.first_name, s.first_name],
    ['lastName', p.last_name, s.last_name],
    ['email', p.email, s.email],
    ['birthDate', p.birth_date, s.birth_date],
  ];
  for (const [field, a, b] of fields) {
    if (a !== null && b !== null && a !== b) conflicts.push({ field, primary: a, secondary: b });
    else if (a === null && b !== null) fills.push({ field, value: b });
  }
  if (p.phone_e164 !== null && s.phone_e164 !== null) conflicts.push({ field: 'phone', primary: maskPhone(p.phone_e164), secondary: maskPhone(s.phone_e164) });
  if (p.status !== s.status) conflicts.push({ field: 'status', primary: p.status, secondary: s.status });
  return { conflicts, fills };
}

/** Обе строки под замком в порядке id (меньший первым) – без взаимоблокировки с lockClients броней и обезличиванием. */
async function lockPair(tx: Tx, primaryId: string, secondaryId: string): Promise<{ p: Row; s: Row }> {
  const r = await tx.query<Row>(`SELECT ${ROW_COLS} FROM app.clients WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[primaryId, secondaryId]]);
  const p = r.rows.find((x) => x.id === primaryId.toLowerCase());
  const s = r.rows.find((x) => x.id === secondaryId.toLowerCase());
  if (!p || !s) throw notFound();
  return { p, s };
}

/** Видимость обеих карточек в зоне (K1): не-Владелец – только клиенты своих филиалов, иначе 404 как у карточки. */
async function assertVisible(db: Db, ctx: AccessContext, ids: string[], links: ClientBranchLinks): Promise<void> {
  const scope = scopeFilter(ctx, 'client.view.basic');
  if (scope.kind === 'none') throw notFound();
  if (scope.kind === 'all') return;
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.clients c WHERE c.id = ANY($1::uuid[]) AND ${links.existsSql('c.id', '$2::uuid[]')}`,
    [ids, scope.branchIds],
  );
  if ((r.rows[0]?.n ?? 0) !== ids.length) throw notFound();
}

export async function mergePreview(
  db: Db,
  ctx: AccessContext,
  input: { primaryId: string; secondaryId: string },
  links: ClientBranchLinks = noBranchLinks,
  clock: Clock = systemClock,
): Promise<MergePreview> {
  checkIds(input.primaryId, input.secondaryId);
  const list = orderedMergers();
  const primary = await getClientCard(db, ctx, input.primaryId, links); // вне зоны – 404
  const secondary = await getClientCard(db, ctx, input.secondaryId, links);
  const rows = await db.query<Row>(`SELECT ${ROW_COLS} FROM app.clients WHERE id = ANY($1::uuid[])`, [[primary.id, secondary.id]]);
  const p = rows.rows.find((x) => x.id === primary.id)!;
  const s = rows.rows.find((x) => x.id === secondary.id)!;
  assertMergeable(s);
  assertMergeable(p);
  const now = clock.now();
  const modules: MergePreview['modules'] = {};
  for (const m of list) modules[m.name] = { primary: await m.preview(db, p.id, now), secondary: await m.preview(db, s.id, now) };
  const blocker = primaryBlocker(p, s);
  return { primary, secondary, modules, ...diff(p, s), statusAfter: statusAfter(p, s).status, canMerge: blocker === null, blocker };
}

export async function mergeClients(
  tx: Tx,
  ctx: AccessContext,
  input: { primaryId: string; secondaryId: string; reason: MergeReason },
  meta: AuditRequestMeta,
  links: ClientBranchLinks = noBranchLinks,
  clock: Clock = systemClock,
): Promise<MergeResult> {
  checkIds(input.primaryId, input.secondaryId);
  if (!(MERGE_REASONS as readonly string[]).includes(input.reason)) {
    throw new AppError('VALIDATION_FAILED', 400, 'Неверное основание объединения', { field: 'reason', allowed: MERGE_REASONS });
  }
  const list = orderedMergers();
  const { p, s } = await lockPair(tx, input.primaryId, input.secondaryId);
  await assertVisible(tx, ctx, [p.id, s.id], links);
  assertMergeable(s);
  assertMergeable(p);
  const blocker = primaryBlocker(p, s);
  if (blocker) throw new AppError('CLIENT_NOT_MERGEABLE', 409, 'Основной должна быть зарегистрированная карточка', { clientId: p.id, reason: blocker });

  const now = clock.now();
  const mctx: MergeContext = { mergeId: randomUUID(), staffId: ctx.actor.staffId, reason: input.reason, now };
  const results: MergeResult['results'] = {};
  for (const m of list) results[m.name] = await m.reassign(tx, s.id, p.id, mctx);

  // Вторая карточка – как при обезличивании (D4-62): ПДн и следы входа; журнал согласий не трогаем (история по id).
  await tx.query(
    `UPDATE app.clients SET phone_e164 = NULL, phone_verified_at = NULL, first_name = NULL, last_name = NULL, email = NULL, birth_date = NULL,
       status = 'merged', merged_into_id = $2, status_reason = NULL, status_until = NULL, row_version = row_version + 1 WHERE id = $1`,
    [s.id, p.id],
  );
  await tx.query(
    `UPDATE app.client_sessions SET revoked_at = coalesce(revoked_at, $2), revoke_reason = coalesce(revoke_reason, 'blocked'), user_agent = NULL WHERE client_id = $1`,
    [s.id, now],
  );
  await tx.query(
    `UPDATE app.push_subscriptions SET revoked_at = coalesce(revoked_at, $2), revoke_reason = coalesce(revoke_reason, 'unsubscribed'), updated_at = $2
     WHERE client_id = $1 AND revoked_at IS NULL`,
    [s.id, now],
  );
  if (s.phone_e164) await tx.query('DELETE FROM app.client_otp_challenges WHERE phone_e164 = $1', [s.phone_e164]);
  // Настройки уведомлений: у основной свои; нет строки – берём строку второй (решение D5-05).
  await tx.query(
    `INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled, updated_at)
     SELECT $2::uuid, reminders_enabled, marketing_enabled, $3::timestamptz FROM app.client_notification_prefs WHERE client_id = $1
     ON CONFLICT (client_id) DO NOTHING`,
    [s.id, p.id, now],
  );

  // Основная: пустое заполняется из второй, статус – с учётом блокировки второй.
  const { fills } = diff(p, s);
  const st = statusAfter(p, s);
  await tx.query(
    `UPDATE app.clients SET first_name = coalesce(first_name, $2), last_name = coalesce(last_name, $3), email = coalesce(email, $4),
       birth_date = coalesce(birth_date, $5::date), status = $6, status_reason = $7, status_until = $8, row_version = row_version + 1 WHERE id = $1`,
    [p.id, s.first_name, s.last_name, s.email, s.birth_date, st.status, st.reason, st.until],
  );

  await tx.query(
    `INSERT INTO journal.client_merges (id, primary_client_id, secondary_client_id, reason, staff_id, merged_at, results) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [mctx.mergeId, p.id, s.id, input.reason, mctx.staffId, now, JSON.stringify(results)],
  );
  await writeAudit(
    tx,
    meta,
    {
      action: 'client.merged',
      object: { type: 'client', id: p.id },
      before: { status: p.status },
      after: { status: st.status, secondaryId: s.id, mergeId: mctx.mergeId, results, filled: fills.map((f) => f.field) },
      reason: input.reason,
    },
    clock,
  );
  await writeAudit(
    tx,
    meta,
    { action: 'client.status_changed', object: { type: 'client', id: s.id }, before: { status: s.status }, after: { status: 'merged', mergedIntoId: p.id, mergeId: mctx.mergeId }, reason: input.reason },
    clock,
  );
  return { mergeId: mctx.mergeId, primaryId: p.id, secondaryId: s.id, status: 'merged', results };
}
