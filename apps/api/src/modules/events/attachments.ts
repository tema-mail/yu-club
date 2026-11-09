// Вложения мероприятия (K19 §9, 11 §11.4): тип владельца 'event' в реестре core/files.ts. Чтение – event.view, запись –
// event.money.record (документ к расходу кладёт тот, кто вносит расход). Вне зоны – 404 как у несуществующего, в зоне без
// права – 403 (guardEvent, K1). Файл выдаётся только через GET /attachments/:id.
import { registerAttachmentOwner } from '../../core/files.ts';
import type { AccessContext, Action } from '../../core/permissions.ts';
import type { Db } from '../../core/audit.ts';
import { getEventRow, guardEvent, notFound } from './events.ts';

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
