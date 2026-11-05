// S4-52. Подписки content на события K4 «Этап 4»: смена слага города, филиала, комнаты → строка истории адресов (K23 §5).
// Событие, а не прямой вызов: network и resources не зависят от content. Повторную доставку гасит processed_events, запись идемпотентна сама
// (ON CONFLICT в recordSlugChange). Окно до обработки – секунды, старый адрес в это время отдаёт 404 (принятый риск K23 §5).
import type { Db } from '../../core/audit.ts';
import { listSubscriptions, subscribe, type Tx } from '../../core/outbox.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { recordSlugChange } from './paths.ts';

export const SLUG_HANDLERS = {
  city: 'content.slug-history.city',
  branch: 'content.slug-history.branch',
  room: 'content.slug-history.room',
} as const;

const db = (tx: Tx) => tx as unknown as Db;

/** Регистрация подписок (один раз на процесс; повторный вызов ничего не делает). */
export function registerContentHandlers(deps: { clock?: Clock } = {}): void {
  if (listSubscriptions().some((s) => s.name === SLUG_HANDLERS.city)) return;
  const clock = deps.clock ?? systemClock;
  subscribe('city.slug_changed', SLUG_HANDLERS.city, async (tx, e) => {
    const p = e.payload;
    await recordSlugChange(db(tx), { entityType: 'city', entityId: p.id, parentKey: '', oldSlug: p.oldSlug, newSlug: p.newSlug }, clock);
  });
  subscribe('branch.slug_changed', SLUG_HANDLERS.branch, async (tx, e) => {
    const p = e.payload;
    await recordSlugChange(db(tx), { entityType: 'branch', entityId: p.id, parentKey: p.parentId ?? '', oldSlug: p.oldSlug, newSlug: p.newSlug }, clock);
  });
  subscribe('room.slug_changed', SLUG_HANDLERS.room, async (tx, e) => {
    const p = e.payload;
    await recordSlugChange(db(tx), { entityType: 'room', entityId: p.id, parentKey: p.parentId, oldSlug: p.oldSlug, newSlug: p.newSlug }, clock);
  });
}
