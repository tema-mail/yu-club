// K13. Публичный вход модуля resources: ресурсы бронирования для booking, pricing, сайта и CRM.
// Другие модули читают помещения, комнаты, ресурсы и состав только отсюда (ADR 0002 п.1–2). Таблицы – 0101, 0102.
// Закрытая комната (status <> 'active') делает недоступными все свои ресурсы (02 §7.3) – без правки строк ресурсов.
import type { Db, Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';

// Состав и единицы – K6 (composite.ts).
export { changeComposition, compositionsDuring, expandToUnits, listUnits, lockCompositions, unitsOfTarget, type CompositionRow, type ResourceUsageProvider, type UnitSet } from './composite.ts';

export interface ResourceInfo {
  id: string;
  branchId: string;
  roomId: string | null;
  roomName: string | null;
  roomSlug: string | null; // rooms.slug – адрес комнаты на сайте (карта сайта п.5)
  roomStatus: string | null;
  type: string;
  name: string;
  status: 'active' | 'unavailable' | 'archived';
  selfBookable: boolean;
  stepMinutes: number; // override ?? dict_resource_types.step_minutes (15 §7.2)
  zone: 'pc' | 'vr' | 'ps';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

// Зона (K13): pc ← pc; vr ← vr_seat; ps ← ps_room; комната целиком и составная – по соседям в комнате
// (есть VR-место → vr, иначе ps-комната → ps, иначе pc). Решение S1-01: признака зоны у комнаты в модели нет.
const ZONE_SQL = `CASE r.resource_type
    WHEN 'pc' THEN 'pc' WHEN 'vr_seat' THEN 'vr' WHEN 'ps_room' THEN 'ps'
    ELSE CASE
      WHEN EXISTS (SELECT 1 FROM app.resources n WHERE n.room_id = r.room_id AND n.resource_type = 'vr_seat' AND n.status <> 'archived') THEN 'vr'
      WHEN EXISTS (SELECT 1 FROM app.resources n WHERE n.room_id = r.room_id AND n.resource_type = 'ps_room' AND n.status <> 'archived') THEN 'ps'
      ELSE 'pc' END
  END`;

export const RESOURCE_INFO_SELECT = `SELECT r.id, r.branch_id AS "branchId", r.room_id AS "roomId", rm.name AS "roomName", rm.slug AS "roomSlug",
    rm.status AS "roomStatus", r.resource_type AS type, r.name, r.status, r.self_bookable AS "selfBookable",
    coalesce(r.step_minutes_override, t.step_minutes)::int AS "stepMinutes", ${ZONE_SQL} AS zone
  FROM app.resources r
  JOIN app.dict_resource_types t ON t.code = r.resource_type
  LEFT JOIN app.rooms rm ON rm.id = r.room_id`;

/** Один ресурс. Нет (или id не uuid) → null. */
export async function getResource(db: Db | Tx, resourceId: string): Promise<ResourceInfo | null> {
  if (!isUuid(resourceId)) return null;
  const r = await db.query<ResourceInfo>(`${RESOURCE_INFO_SELECT} WHERE r.id = $1`, [resourceId]);
  return r.rows[0] ?? null;
}

/** Для сайта и сетки: только active, selfBookable, комната (если есть) active и опубликована (02 §7.4). */
export async function listBookableResources(db: Db | Tx, branchId: string, zone?: ResourceInfo['zone']): Promise<ResourceInfo[]> {
  if (!isUuid(branchId)) return [];
  const params: unknown[] = [branchId];
  let zoneSql = '';
  if (zone !== undefined) {
    params.push(zone);
    zoneSql = ` AND ${ZONE_SQL} = $2`;
  }
  const r = await db.query<ResourceInfo>(
    `${RESOURCE_INFO_SELECT}
     WHERE r.branch_id = $1 AND r.status = 'active' AND r.self_bookable
       AND (r.room_id IS NULL OR (rm.status = 'active' AND rm.is_published))${zoneSql}
     ORDER BY r.sort_order, r.name, r.id`,
    params,
  );
  return r.rows;
}

/** Бронируем ли сейчас: active + selfBookable + комната active (02 §7.3). Иначе RESOURCE_UNAVAILABLE. */
export function assertBookable(r: ResourceInfo): void {
  if (r.status !== 'active' || !r.selfBookable || (r.roomId !== null && r.roomStatus !== 'active')) {
    throw new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи', { resourceId: r.id });
  }
}

/** network CalendarTargets (K13): комната / ресурс существует, не в архиве и принадлежит филиалу. */
export const calendarTargets = {
  async belongsToBranch(db: Db | Tx, target: { type: 'room' | 'resource'; id: string }, branchId: string): Promise<boolean> {
    if (!isUuid(target.id) || !isUuid(branchId)) return false;
    const table = target.type === 'room' ? 'app.rooms' : 'app.resources';
    const r = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND branch_id = $2 AND status <> 'archived'`, [target.id, branchId]);
    return r.rowCount === 1;
  },
};

/** Первый активный ресурс типа в филиале; null – такого нет (K20 §8.2: подарочный ресурс). */
export async function activeResourceOfType(db: Db | Tx, branchId: string, type: string): Promise<{ id: string; roomId: string | null } | null> {
  const r = await db.query<{ id: string; room_id: string | null }>(`SELECT id, room_id FROM app.resources WHERE branch_id = $1 AND resource_type = $2 AND status = 'active' ORDER BY id LIMIT 1`, [branchId, type]);
  const row = r.rows[0];
  return row ? { id: row.id, roomId: row.room_id } : null;
}

/** Ресурс типа в любом статусе, активный первым: архивный считается существующим (K20 §8.2, D3-13). */
export async function anyResourceOfType(db: Db | Tx, branchId: string, type: string): Promise<string | null> {
  const r = await db.query<{ id: string }>(`SELECT id FROM app.resources WHERE branch_id = $1 AND resource_type = $2 ORDER BY status = 'active' DESC, id LIMIT 1`, [branchId, type]);
  return r.rows[0]?.id ?? null;
}

/** Первая комната филиала, где не меньше minSeats мест типа seatType с одной активной единицей каждое; единицы – по порядку кода. Нет – null (D3-13). */
export async function roomWithSeats(db: Db | Tx, branchId: string, seatType: string, minSeats: number): Promise<{ roomId: string; unitIds: string[] } | null> {
  const r = await db.query<{ room_id: string; unit_id: string; code: string }>(
    `SELECT r.room_id, ru.unit_id, u.code
       FROM app.resources r
       JOIN app.rooms rm ON rm.id = r.room_id AND rm.status <> 'archived'
       JOIN app.resource_units ru ON ru.resource_id = r.id AND ru.valid_to IS NULL
       JOIN app.occupancy_units u ON u.id = ru.unit_id AND u.status = 'active'
      WHERE r.branch_id = $1 AND r.resource_type = $2 AND r.status <> 'archived'
        AND (SELECT count(*) FROM app.resource_units x WHERE x.resource_id = r.id AND x.valid_to IS NULL) = 1
      ORDER BY rm.sort_order, rm.id, u.code`,
    [branchId, seatType],
  );
  const byRoom = new Map<string, string[]>();
  for (const row of r.rows) byRoom.set(row.room_id, [...(byRoom.get(row.room_id) ?? []), row.unit_id]);
  for (const [roomId, units] of byRoom) if (units.length >= minSeats) return { roomId, unitIds: units.slice(0, minSeats) };
  return null;
}
