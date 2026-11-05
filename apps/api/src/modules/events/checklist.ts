// S3-53. Чек-лист подготовки мероприятия (K20 §5, 11 §6): 10 пунктов засевает createEvent, сотрудник добавляет свои и
// помечает «не нужно»; удаления нет (у yu_app отозван DELETE). Чек-лист не заменяет финансовые операции: пункт «проверка
// оплаты» показывает остаток к оплате, но ничего в деньгах не меняет – остаток читается из money.ts и передаётся параметром.
import { z } from 'zod';
import { diffFields, writeAudit, type AuditRequestMeta, type Db, type Tx } from '../../core/audit.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { lockEvent, notFound, parseBody, UUID_RE } from './events.ts';

export type ChecklistStatus = 'todo' | 'done' | 'not_needed';
export interface ChecklistItemDto {
  id: string;
  code: string | null;
  title: string;
  status: ChecklistStatus;
  responsibleStaffId: string | null;
  comment: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Только у пункта code='payment': текущий остаток к оплате (показ, 11 §6). */
  dueKop?: number;
}

interface ItemRow {
  id: string;
  event_id: string;
  code: string | null;
  title: string;
  status: ChecklistStatus;
  responsible_staff_id: string | null;
  comment: string | null;
  updated_by: string | null;
  updated_at: Date | null;
}
const COLS = 'id, event_id, code, title, status, responsible_staff_id, comment, updated_by, updated_at';

const toDto = (r: ItemRow): ChecklistItemDto => ({
  id: r.id, code: r.code, title: r.title, status: r.status, responsibleStaffId: r.responsible_staff_id, comment: r.comment, updatedBy: r.updated_by, updatedAt: r.updated_at?.toISOString() ?? null,
});

const Uuid = z.string().regex(UUID_RE);
const addSchema = z.object({ title: z.string().trim().min(1).max(200), responsibleStaffId: Uuid.nullish(), comment: z.string().trim().max(2000).nullish() });
const updateSchema = z.object({ status: z.enum(['todo', 'done', 'not_needed']).optional(), responsibleStaffId: Uuid.nullish(), comment: z.string().trim().max(2000).nullish() });

/** Пункты по порядку; dueOf – остаток к оплате из money.ts: вызывается только чтобы показать его в пункте оплаты. */
export async function listChecklist(db: Db, eventId: string, dueOf: (db: Db, eventId: string) => Promise<number>): Promise<ChecklistItemDto[]> {
  const r = await db.query<ItemRow>(`SELECT ${COLS} FROM app.event_checklist WHERE event_id = $1 ORDER BY sort_order, id`, [eventId]);
  const items = r.rows.map(toDto);
  const payment = items.find((i) => i.code === 'payment');
  if (payment) payment.dueKop = await dueOf(db, eventId);
  return items;
}

export async function addChecklistItem(tx: Tx, ctx: AccessContext, eventId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ChecklistItemDto> {
  const input = parseBody(addSchema, raw);
  const e = await lockEvent(tx, ctx, eventId, 'event.manage');
  const now = clock.now();
  const r = await tx.query<ItemRow>(
    `INSERT INTO app.event_checklist (event_id, title, responsible_staff_id, comment, updated_by, updated_at, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort_order), 0) + 1 FROM app.event_checklist WHERE event_id = $1)) RETURNING ${COLS}`,
    [e.id, input.title, input.responsibleStaffId ?? null, input.comment ?? null, ctx.actor.staffId, now],
  );
  const dto = toDto(r.rows[0]!);
  await writeAudit(tx, meta, { action: 'event.checklist_changed', object: { type: 'event', id: e.id }, branchId: e.branch_id, after: { itemId: dto.id, title: dto.title, status: dto.status } }, clock);
  return dto;
}

/** Статус, ответственный, комментарий. Деньги мероприятия пункт не трогает ни при каком статусе. */
export async function updateChecklistItem(tx: Tx, ctx: AccessContext, itemId: string, raw: unknown, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<ChecklistItemDto> {
  const input = parseBody(updateSchema, raw);
  if (!UUID_RE.test(itemId)) throw notFound();
  const found = await tx.query<{ event_id: string }>('SELECT event_id FROM app.event_checklist WHERE id = $1', [itemId]);
  if (!found.rows[0]) throw notFound();
  const e = await lockEvent(tx, ctx, found.rows[0].event_id, 'event.manage');
  const cur = (await tx.query<ItemRow>(`SELECT ${COLS} FROM app.event_checklist WHERE id = $1 FOR UPDATE`, [itemId])).rows[0]!;
  const r = await tx.query<ItemRow>(
    `UPDATE app.event_checklist SET status = $2, responsible_staff_id = $3, comment = $4, updated_by = $5, updated_at = $6 WHERE id = $1 RETURNING ${COLS}`,
    [
      itemId, input.status ?? cur.status,
      input.responsibleStaffId !== undefined ? input.responsibleStaffId : cur.responsible_staff_id,
      input.comment !== undefined ? input.comment : cur.comment,
      ctx.actor.staffId, clock.now(),
    ],
  );
  const dto = toDto(r.rows[0]!);
  const old = toDto(cur);
  const pick = (d: ChecklistItemDto) => ({ status: d.status, responsibleStaffId: d.responsibleStaffId, comment: d.comment });
  const diff = diffFields(pick(old), pick(dto));
  await writeAudit(tx, meta, { action: 'event.checklist_changed', object: { type: 'event', id: e.id }, branchId: e.branch_id, before: { itemId, ...diff.before }, after: { itemId, ...diff.after } }, clock);
  return dto;
}
