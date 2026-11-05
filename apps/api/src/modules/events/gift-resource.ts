// S3-62. Подарочный ресурс в бою (K20 §8.2): ensureGiftResource(branchId) – ресурс gift_vr «Подарок: 2 VR» (VR1+VR2, без PS4,
// self_bookable=false, шаг 5 минут) и тариф 0 ₽ в филиале с VR-комнатой. Вызывается при создании VR-комнаты (экран ресурсов) и боевой
// идемпотентной процедурой db/seed/gift-resources.ts для уже существующих комнат; демо-посев S3-96 зовёт её же, своей копии нет.
// VR-комната – комната филиала, где не меньше двух мест vr_seat с одной единицей каждое и единицы не архивные. Создаётся один ресурс
// на филиал (giftResourceOf). Команды модулей resources и pricing – с их проверками и аудитом. Замок филиала: параллельные вызовы
// не создают дублей. Право: действие системы, вызванное созданием комнаты или процедурой: сотруднику не нужно право на тарифы.
import { randomUUID } from 'node:crypto';
import type { AuditRequestMeta, Db, Tx } from '../../core/audit.ts';
import type { AccessContext } from '../../core/permissions.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { createTariff } from '../pricing/tariff.ts';
import { createEntity } from '../resources/routes.ts';
import { GIFT_RESOURCE_TYPE } from './gift-booking.ts';

export const GIFT_RESOURCE_NAME = 'Подарок: 2 VR';
export const GIFT_TARIFF_NAME = 'Подарок имениннику – 0 ₽';
const STEP_MINUTES = 5;
const DEVICES = 2;

export type EnsureGiftResult = { status: 'no_vr_room' } | { status: 'created' | 'exists'; resourceId: string; tariffCreated: boolean };

/** Первая VR-комната филиала и две её единицы по порядку кода (VR1, VR2). Нет – null. */
async function vrRoomOf(db: Db, branchId: string): Promise<{ roomId: string; unitIds: string[] } | null> {
  const r = await db.query<{ room_id: string; unit_id: string; code: string }>(
    `SELECT r.room_id, ru.unit_id, u.code
       FROM app.resources r
       JOIN app.rooms rm ON rm.id = r.room_id AND rm.status <> 'archived'
       JOIN app.resource_units ru ON ru.resource_id = r.id AND ru.valid_to IS NULL
       JOIN app.occupancy_units u ON u.id = ru.unit_id AND u.status = 'active'
      WHERE r.branch_id = $1 AND r.resource_type = 'vr_seat' AND r.status <> 'archived'
        AND (SELECT count(*) FROM app.resource_units x WHERE x.resource_id = r.id AND x.valid_to IS NULL) = 1
      ORDER BY rm.sort_order, rm.id, u.code`,
    [branchId],
  );
  const byRoom = new Map<string, string[]>();
  for (const row of r.rows) byRoom.set(row.room_id, [...(byRoom.get(row.room_id) ?? []), row.unit_id]);
  for (const [roomId, units] of byRoom) if (units.length >= DEVICES) return { roomId, unitIds: units.slice(0, DEVICES) };
  return null;
}

/** Создать, чего не хватает. Повтор – без дублей; архивный подарочный ресурс не воскрешается: его архивировали намеренно (status 'exists'). */
export async function ensureGiftResource(tx: Tx, ctx: AccessContext, branchId: string, meta: AuditRequestMeta, clock: Clock = systemClock): Promise<EnsureGiftResult> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('gift-resource:' || $1, 0))`, [branchId]);
  const system: AccessContext = { ...ctx, role: 'owner', network: true };
  const existing = await tx.query<{ id: string }>(`SELECT id FROM app.resources WHERE branch_id = $1 AND resource_type = $2 ORDER BY status = 'active' DESC, id LIMIT 1`, [branchId, GIFT_RESOURCE_TYPE]);
  let resourceId = existing.rows[0]?.id ?? null;
  let status: 'created' | 'exists' = 'exists';
  if (!resourceId) {
    const room = await vrRoomOf(tx, branchId);
    if (!room) return { status: 'no_vr_room' };
    const row = await createEntity(tx, system, 'resource', branchId, { roomId: room.roomId, type: GIFT_RESOURCE_TYPE, name: GIFT_RESOURCE_NAME, selfBookable: false, stepMinutesOverride: STEP_MINUTES, unitIds: room.unitIds }, meta, clock);
    resourceId = row.id;
    status = 'created';
  }
  const hasTariff = await tx.query(`SELECT 1 FROM app.tariffs WHERE branch_id = $1 AND resource_type = $2 AND status = 'active' LIMIT 1`, [branchId, GIFT_RESOURCE_TYPE]);
  let tariffCreated = false;
  if (hasTariff.rowCount !== 1) {
    await createTariff(tx, system, { branchId, resourceType: GIFT_RESOURCE_TYPE, name: GIFT_TARIFF_NAME, unitMinutes: STEP_MINUTES, pricePerUnitKop: 0, durationFromMin: 0, validFrom: clock.now().toISOString(), status: 'active' }, meta, clock);
    tariffCreated = true;
  }
  return { status, resourceId, tariffCreated };
}

/** Контекст системной процедуры от имени Владельца-исполнителя (K2: действие подписано учёткой, запустившей процедуру). */
export function systemGiftContext(staffId: string, at: Date): { ctx: AccessContext; meta: AuditRequestMeta } {
  const ctx: AccessContext = { actor: { kind: 'staff', staffId, sessionId: randomUUID() }, role: 'owner', network: true, cityIds: new Set(), branchIds: new Set(), at };
  return { ctx, meta: { actor: ctx.actor, access: ctx, source: 'cli', requestId: randomUUID() } };
}
