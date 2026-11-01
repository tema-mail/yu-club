// S1-02. K6: единицы занятости и составные конфигурации ресурсов (R-01 по умолчанию, 01 §5.1–5.2, 02 §8.4).
// Обычный ресурс (ПК, VR-место, PS-комната) → одна своя единица; «комната целиком» и составной → несколько.
// PS4 – единица без ресурса: самостоятельно не бронируется, занимается только в составе комнаты.
// Состав – строки resource_units с периодом действия: смена закрывает старые (valid_to) и открывает новые,
// прошлое не переписывается – брони хранят свои единицы снимком (occupancy, с S1-07 booking_versions.unit_ids).
import { writeAudit, type AuditRequestMeta, type Tx } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import { assertBookable, getResource, isUuid } from './index.ts';

export interface UnitSet {
  resourceId: string;
  unitIds: string[]; // отсортированы по id
}

export interface UnitInfo {
  id: string;
  branchId: string;
  roomId: string | null;
  code: string;
  name: string;
  status: 'active' | 'archived';
}

const unavailable = (resourceId: string, why: string) =>
  new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи', { resourceId, why });

/** Сравнение uuid как в Postgres (байты = строчные hex): порядок совпадает с ORDER BY id. */
export const sortIds = (ids: Iterable<string>): string[] => [...new Set([...ids].map((s) => s.toLowerCase()))].sort();

/** Состав ресурса на момент `at` (без проверок доступности) – для CRM и снимков. */
export async function compositionAt(tx: Tx, resourceId: string, at: Date): Promise<string[]> {
  if (!isUuid(resourceId)) return [];
  const r = await tx.query<{ unit_id: string }>(
    `SELECT unit_id FROM app.resource_units
     WHERE resource_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY unit_id`,
    [resourceId, at],
  );
  return r.rows.map((x) => x.unit_id);
}

/** K6: развернуть ресурс в единицы на момент `at` (состав, действующий на начало интервала).
 *  Ресурс/комната не active, self_bookable=false, пустой состав, единица в архиве → RESOURCE_UNAVAILABLE. */
export async function expandToUnits(tx: Tx, resourceId: string, at: Date): Promise<UnitSet> {
  const r = await getResource(tx, resourceId);
  if (!r) throw unavailable(resourceId, 'not_found');
  assertBookable(r);
  const u = await tx.query<{ unit_id: string; status: string }>(
    `SELECT ru.unit_id, u.status FROM app.resource_units ru JOIN app.occupancy_units u ON u.id = ru.unit_id
     WHERE ru.resource_id = $1 AND ru.valid_from <= $2 AND (ru.valid_to IS NULL OR ru.valid_to > $2) ORDER BY ru.unit_id`,
    [resourceId, at],
  );
  if (u.rows.length === 0) throw unavailable(resourceId, 'empty_composition');
  if (u.rows.some((x) => x.status !== 'active')) throw unavailable(resourceId, 'unit_archived');
  return { resourceId: r.id, unitIds: u.rows.map((x) => x.unit_id) };
}

/** Единицы филиала: все переданные – существуют, в этом филиале и активны; иначе RESOURCE_LINK_INVALID. */
async function checkUnits(tx: Tx, branchId: string, unitIds: string[]): Promise<void> {
  if (!unitIds.every(isUuid)) throw new AppError('RESOURCE_LINK_INVALID', 422, 'Единица не найдена в этом филиале', { field: 'unitIds' });
  const r = await tx.query(`SELECT 1 FROM app.occupancy_units WHERE id = ANY($1::uuid[]) AND branch_id = $2 AND status = 'active'`, [unitIds, branchId]);
  if (r.rowCount !== unitIds.length) {
    throw new AppError('RESOURCE_LINK_INVALID', 422, 'Единица не найдена в этом филиале или в архиве', { field: 'unitIds' });
  }
}

/** Будущие брони и удержания ресурса: активные строки occupancy с концом позже `from`, чей набор единиц равен составу
 *  ресурса на начало интервала строки (так их пишет occupy через expandToUnits).
 *  Решение до S1-06/S1-07: таблиц holds/bookings ещё нет, источник → ресурс определяется по набору единиц. Ресурсы с
 *  одинаковым составом попадут оба – это перестраховка (лишний отказ), не пропуск брони.
 *  Пока нет hold_items, holdIds – id позиций удержаний (source_id). */
export async function futureUsage(tx: Tx, resourceId: string, from: Date): Promise<{ bookingIds: string[]; holdIds: string[] }> {
  const r = await tx.query<{ source_type: string; source_id: string }>(
    `WITH src AS (
       SELECT o.source_type, o.source_id, min(lower(o.period)) AS start, array_agg(o.unit_id ORDER BY o.unit_id) AS units
       FROM app.occupancy o
       WHERE o.active AND o.source_type IN ('booking','hold_item') AND upper(o.period) > $2
         AND o.unit_id IN (SELECT unit_id FROM app.resource_units WHERE resource_id = $1)
         AND NOT EXISTS (SELECT 1 FROM app.occupancy x WHERE x.active AND x.source_type = o.source_type AND x.source_id = o.source_id
                         AND x.unit_id NOT IN (SELECT unit_id FROM app.resource_units WHERE resource_id = $1))
       GROUP BY o.source_type, o.source_id)
     SELECT source_type, source_id FROM src
     WHERE units = (SELECT array_agg(unit_id ORDER BY unit_id) FROM app.resource_units
                    WHERE resource_id = $1 AND valid_from <= src.start AND (valid_to IS NULL OR valid_to > src.start))
     ORDER BY source_type, source_id`,
    [resourceId, from],
  );
  return {
    bookingIds: r.rows.filter((x) => x.source_type === 'booking').map((x) => x.source_id),
    holdIds: r.rows.filter((x) => x.source_type === 'hold_item').map((x) => x.source_id),
  };
}

/** Активные блокировки, выбранные по этому ресурсу и идущие после `from` (ревизия S1-04 п.3): их единицы развёрнуты
 *  по старому составу – новая единица осталась бы незаблокированной. Решение: отказ со списком, как для броней. */
async function futureBlocks(tx: Tx, resourceId: string, from: Date): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM app.resource_blocks
     WHERE status = 'active' AND upper(period) > $2 AND target_type IN ('resource','resources') AND $1::uuid = ANY(target_ids) ORDER BY id`,
    [resourceId, from],
  );
  return r.rows.map((x) => x.id);
}

/** K6: изменить состав с даты. Есть активные брони/удержания ресурса с end > validFrom → COMPOSITION_HAS_FUTURE_BOOKINGS
 *  со списком (сотрудник решает каждую вручную, 01 §12–13). dryRun – только список. Права проверяет вызывающий
 *  (resources.manage, routes.ts). validFrom в прошлом или раньше последнего открытия состава – VALIDATION_FAILED. */
export async function changeComposition(
  tx: Tx,
  input: { resourceId: string; unitIds: string[]; validFrom: Date; dryRun?: boolean },
  meta: AuditRequestMeta,
  clock: Clock = systemClock,
): Promise<{ affectedBookingIds: string[]; affectedHoldIds: string[]; affectedBlockIds: string[]; applied: boolean }> {
  const lock = isUuid(input.resourceId)
    ? await tx.query<{ branch_id: string; status: string }>('SELECT branch_id, status FROM app.resources WHERE id = $1 FOR UPDATE', [input.resourceId])
    : { rows: [] };
  const res = lock.rows[0];
  if (!res) throw new AppError('NOT_FOUND', 404, 'Не найдено');
  if (res.status === 'archived') throw new AppError('RESOURCE_ARCHIVED', 409, 'Объект в архиве');
  const unitIds = sortIds(input.unitIds);
  if (unitIds.length === 0) throw new AppError('VALIDATION_FAILED', 400, 'Состав не может быть пустым', { field: 'unitIds' });
  await checkUnits(tx, res.branch_id, unitIds);
  const now = clock.now();
  if (input.validFrom.getTime() < now.getTime()) {
    throw new AppError('VALIDATION_FAILED', 400, 'Состав меняется с текущего момента или позже – прошлое не переписывается', { field: 'validFrom' });
  }
  const last = await tx.query<{ max: Date | null }>('SELECT max(valid_from) AS max FROM app.resource_units WHERE resource_id = $1', [input.resourceId]);
  if (last.rows[0]?.max && input.validFrom.getTime() <= last.rows[0].max.getTime()) {
    throw new AppError('VALIDATION_FAILED', 400, 'Дата раньше последнего изменения состава', { field: 'validFrom', last: last.rows[0].max });
  }
  const before = await compositionAt(tx, input.resourceId, input.validFrom);
  const same = before.length === unitIds.length && before.every((u, i) => u === unitIds[i]);
  const usage = same ? { bookingIds: [], holdIds: [] } : await futureUsage(tx, input.resourceId, input.validFrom);
  const blockIds = same ? [] : await futureBlocks(tx, input.resourceId, input.validFrom);
  const result = { affectedBookingIds: usage.bookingIds, affectedHoldIds: usage.holdIds, affectedBlockIds: blockIds, applied: false };
  if (same || input.dryRun) return result;
  if (usage.bookingIds.length > 0 || usage.holdIds.length > 0 || blockIds.length > 0) {
    throw new AppError('COMPOSITION_HAS_FUTURE_BOOKINGS', 409, 'У ресурса есть будущие брони или блокировки – решите каждую до смены состава', {
      bookingIds: usage.bookingIds,
      holdIds: usage.holdIds,
      blockIds,
    });
  }
  await tx.query(`UPDATE app.resource_units SET valid_to = $2 WHERE resource_id = $1 AND valid_to IS NULL`, [input.resourceId, input.validFrom]);
  await tx.query(
    `INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, $2 FROM unnest($3::uuid[]) u ORDER BY u`,
    [input.resourceId, input.validFrom, unitIds],
  );
  await writeAudit(
    tx,
    meta,
    {
      action: 'resource.composition_changed',
      object: { type: 'resource', id: input.resourceId },
      branchId: res.branch_id,
      before: { unitIds: before },
      after: { unitIds, validFrom: input.validFrom },
    },
    clock,
  );
  return { ...result, applied: true };
}

// ---- единицы (для CRM и создания ресурса)

const UNIT_SELECT = `id, branch_id AS "branchId", room_id AS "roomId", code, name, status FROM app.occupancy_units`;

export async function listUnits(tx: Tx, branchId: string): Promise<UnitInfo[]> {
  if (!isUuid(branchId)) return [];
  const r = await tx.query<UnitInfo>(`SELECT ${UNIT_SELECT} WHERE branch_id = $1 ORDER BY code, id`, [branchId]);
  return r.rows;
}

/** Новая единица филиала. Код занят → RESOURCE_SLUG_TAKEN. Аудит пишет вызывающий (room.updated / resource.created). */
export async function insertUnit(tx: Tx, input: { branchId: string; roomId: string | null; code: string; name: string }): Promise<UnitInfo> {
  const r = await tx
    .query<UnitInfo>(`INSERT INTO app.occupancy_units (branch_id, room_id, code, name) VALUES ($1, $2, $3, $4) RETURNING ${UNIT_SELECT.replace(' FROM app.occupancy_units', '')}`, [
      input.branchId,
      input.roomId,
      input.code,
      input.name,
    ])
    .catch((err: { code?: string }) => {
      if (err.code === '23505') throw new AppError('RESOURCE_SLUG_TAKEN', 409, 'Код единицы уже занят в филиале', { field: 'unitCode' });
      if (err.code === '23503') throw new AppError('RESOURCE_LINK_INVALID', 422, 'Комната не найдена в этом филиале', { field: 'roomId' });
      throw err;
    });
  return r.rows[0]!;
}

const OWN_UNIT_TYPES = new Set(['pc', 'vr_seat', 'ps_room']);

/** Начальный состав нового ресурса (с момента создания): обычный тип – своя новая единица (код = unitCode ?? имя);
 *  комната целиком / составной – переданные unitIds (можно пусто – тогда ресурс недоступен до changeComposition). */
export async function attachInitialUnits(
  tx: Tx,
  resource: { id: string; branchId: string; roomId: string | null; type: string; name: string },
  input: { unitCode?: string | undefined; unitIds?: string[] | undefined },
  now: Date,
): Promise<string[]> {
  let unitIds: string[];
  if (OWN_UNIT_TYPES.has(resource.type)) {
    if (input.unitIds !== undefined) throw new AppError('VALIDATION_FAILED', 400, 'У обычного ресурса своя единица – unitIds не передаются', { field: 'unitIds' });
    const unit = await insertUnit(tx, { branchId: resource.branchId, roomId: resource.roomId, code: input.unitCode ?? resource.name, name: resource.name });
    unitIds = [unit.id];
  } else {
    if (input.unitCode !== undefined) throw new AppError('VALIDATION_FAILED', 400, 'Составной ресурс собирается из unitIds', { field: 'unitCode' });
    unitIds = sortIds(input.unitIds ?? []);
    if (unitIds.length > 0) await checkUnits(tx, resource.branchId, unitIds);
  }
  if (unitIds.length > 0) {
    await tx.query(`INSERT INTO app.resource_units (resource_id, unit_id, valid_from) SELECT $1, u, $2 FROM unnest($3::uuid[]) u ORDER BY u`, [
      resource.id,
      now,
      unitIds,
    ]);
  }
  return unitIds;
}

/** Единицы цели блокировки (K6 createBlock, S1-04) на момент `at`: единицы как есть; ресурс(ы) – состав на `at`;
 *  комната – все активные единицы комнаты (включая PS4 без ресурса). Чужой филиал / нет / архив → RESOURCE_LINK_INVALID. */
export async function unitsOfTarget(
  tx: Tx,
  branchId: string,
  target: { type: 'unit' | 'resource' | 'room' | 'resources'; ids: string[] },
  at: Date,
): Promise<string[]> {
  const invalid = () => new AppError('RESOURCE_LINK_INVALID', 422, 'Цель блокировки не найдена в этом филиале', { field: 'target.ids' });
  if (target.ids.length === 0 || !target.ids.every(isUuid)) throw invalid();
  const ids = sortIds(target.ids);
  if (target.type === 'resource' && ids.length !== 1) throw invalid();
  const table = target.type === 'unit' ? 'occupancy_units' : target.type === 'room' ? 'rooms' : 'resources';
  const found = await tx.query(`SELECT 1 FROM app.${table} WHERE id = ANY($1::uuid[]) AND branch_id = $2 AND status <> 'archived'`, [ids, branchId]);
  if (found.rowCount !== ids.length) throw invalid();
  if (target.type === 'unit') return ids;
  const r =
    target.type === 'room'
      ? await tx.query<{ id: string }>(`SELECT id FROM app.occupancy_units WHERE room_id = ANY($1::uuid[]) AND status = 'active' ORDER BY id`, [ids])
      : await tx.query<{ id: string }>(
          `SELECT DISTINCT unit_id AS id FROM app.resource_units
           WHERE resource_id = ANY($1::uuid[]) AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY 1`,
          [ids, at],
        );
  if (r.rows.length === 0) throw invalid();
  return r.rows.map((x) => x.id);
}

/** Для транзакции занятия (ревизия S1-02 п.1): строки ресурсов FOR SHARE по id – против FOR UPDATE в changeComposition,
 *  затем сверка: переданные единицы = состав на начало интервала. Иначе состав сменили между expandToUnits и записью →
 *  COMPOSITE_CHANGED (K5). Вызывать до захвата единиц: порядок замков «ресурсы → единицы» у всех команд один. */
export async function lockCompositions(tx: Tx, items: Array<{ resourceId: string; unitIds: string[]; at: Date }>): Promise<void> {
  const ids = sortIds(items.map((i) => i.resourceId));
  if (!ids.every(isUuid)) throw new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи');
  const r = await tx.query('SELECT id FROM app.resources WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
  if (r.rowCount !== ids.length) throw new AppError('RESOURCE_UNAVAILABLE', 409, 'Это место недоступно для записи');
  for (const i of items) {
    const now = await compositionAt(tx, i.resourceId, i.at);
    const sent = sortIds(i.unitIds);
    if (now.length !== sent.length || now.some((u, k) => u !== sent[k])) {
      throw new AppError('COMPOSITE_CHANGED', 409, 'Конфигурация изменилась, выберите заново', { resourceId: i.resourceId });
    }
  }
}
