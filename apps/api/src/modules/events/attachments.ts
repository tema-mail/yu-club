// Вложения мероприятия (K19 §9, 11 §11.4): тип владельца 'event' в реестре core/files.ts. Чтение – event.view, запись –
// event.money.record (документ к расходу кладёт тот, кто вносит расход). Вне зоны – 404 как у несуществующего, в зоне без
// права – 403 (guardEvent, K1). Файл выдаётся только через GET /attachments/:id.
// Документ к расходу (0435): вложение этого мероприятия ↔ операция, живая связь expense этого мероприятия; одна живая строка
// на операцию, новый документ заменяет прежний (строка остаётся с replaced_at). Связи читаются через finance/links.ts.
import { writeAudit, type AuditRequestMeta, type Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { getAttachment, registerAttachmentOwner, type AttachmentDto } from '../../core/files.ts';
import type { Tx } from '../../core/ledger.ts';
import type { AccessContext, Action } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { linksOf } from '../finance/links.ts';
import { getEventRow, guardEvent, lockEvent, notFound, UUID_RE } from './events.ts';

async function check(db: Db, ctx: AccessContext, eventId: string, action: Action): Promise<void> {
  const e = await getEventRow(db, eventId);
  if (!e) throw notFound();
  guardEvent(ctx, e.branch_id, action);
}

/** Регистрирует владельца 'event' – один раз на процесс (server.ts registerModuleHooks). */
export function registerEventAttachmentOwner(): void {
  registerAttachmentOwner('event', {
    canRead: (db, ctx, id) => check(db, ctx, id, 'event.view'),
    canWrite: (db, ctx, id) => check(db, ctx, id, 'event.money.record'),
  });
}

export interface ExpenseDocument {
  operationId: string;
  attachmentId: string;
}

const badDocument = () => new AppError('VALIDATION_FAILED', 400, 'Документ не найден у этого мероприятия', { field: 'attachmentId' });

async function documentOfEvent(tx: Tx, ctx: AccessContext, eventId: string, attachmentId: string): Promise<AttachmentDto> {
  if (!UUID_RE.test(attachmentId)) throw badDocument();
  let a: AttachmentDto;
  try {
    a = (await getAttachment(tx, ctx, attachmentId)).attachment;
  } catch (err) {
    // чужая зона (404) и вложение другого владельца без права чтения (403) неотличимы от несуществующего id (K1)
    if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN')) throw badDocument();
    throw err;
  }
  if (a.ownerType !== 'event' || a.ownerId !== eventId || a.status !== 'active') throw badDocument();
  return a;
}

/** Документ к расходу мероприятия (11 §11.4). Право event.money.record. Операция – живая связь expense этого мероприятия,
 *  иначе 404 (чужая неотличима от несуществующей); вложение – этого мероприятия и active, иначе 400. Повтор с тем же
 *  вложением – без изменений и без аудита. */
export async function setExpenseDocument(
  tx: Tx,
  ctx: AccessContext,
  eventId: string,
  input: ExpenseDocument,
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<ExpenseDocument> {
  const e = await lockEvent(tx, ctx, eventId, 'event.money.record');
  if (!UUID_RE.test(input.operationId)) throw notFound();
  const link = (await linksOf(tx, { type: 'event', id: e.id })).find((l) => l.operation.id === input.operationId && l.role === 'expense');
  if (!link) throw notFound();
  await documentOfEvent(tx, ctx, e.id, input.attachmentId);
  const prev = await tx.query<{ id: string; attachment_id: string }>(
    `SELECT id, attachment_id FROM app.event_expense_documents WHERE operation_id = $1 AND replaced_at IS NULL`,
    [input.operationId],
  );
  const before = prev.rows[0];
  const result = { operationId: input.operationId, attachmentId: input.attachmentId };
  if (before?.attachment_id === input.attachmentId) return result;
  const now = clock.now();
  if (before) await tx.query(`UPDATE app.event_expense_documents SET replaced_at = $2, replaced_by = $3 WHERE id = $1`, [before.id, now, ctx.actor.staffId]);
  await tx.query(
    `INSERT INTO app.event_expense_documents (event_id, operation_id, attachment_id, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [e.id, input.operationId, input.attachmentId, ctx.actor.staffId, now],
  );
  await writeAudit(
    tx,
    meta,
    {
      action: 'event.money_linked',
      object: { type: 'event', id: e.id },
      branchId: e.branch_id,
      ...(before ? { before: { operationId: input.operationId, attachmentId: before.attachment_id } } : {}),
      after: result,
    },
    clock,
  );
  return result;
}

/** Живые документы расходов мероприятия: operationId → attachmentId (для GET /events/:id/money). */
export async function expenseDocumentsOf(db: Db, eventId: string): Promise<Map<string, string>> {
  const r = await db.query<{ operation_id: string; attachment_id: string }>(
    `SELECT operation_id, attachment_id FROM app.event_expense_documents WHERE event_id = $1 AND replaced_at IS NULL`,
    [eventId],
  );
  return new Map(r.rows.map((x) => [x.operation_id, x.attachment_id]));
}
