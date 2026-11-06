// Правила платного праздника (K20 §4, 20 §4.10 – R-22): гости, комната целиком, непрерывная длительность, формат. Общие для резервирования,
// переноса, правки формата и подтверждения: настройка и формат могли измениться после занятия комнаты.
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { resolveSetting } from '../../core/settings.ts';
import { durationMinutes, fromPgRange, instantToLocal, type Interval, type TimeZone } from '../../core/time.ts';
import { openIntervals } from '../network/index.ts';
import { getResource } from '../resources/index.ts';
import type { EventRow } from './events.ts';

/** Гости праздника (K20 §4): 1…event.party.max_guests. */
export async function assertPartyGuests(db: Db, branchId: string, guests: number, now: Date): Promise<void> {
  const max = (await resolveSetting(db, 'event.party.max_guests', { branchId }, now)).value;
  if (!Number.isInteger(guests) || guests < 1 || guests > max) throw new AppError('PARTY_GUESTS_LIMIT', 422, `Гостей на празднике – от 1 до ${max}`, { max });
}

/** Правила платного праздника (K20 §4, TC-13). Гости перепроверяются: настройка могла измениться с момента ввода. */
export async function assertPartyRules(db: Db, e: EventRow, resource: { type: string }, period: Interval, open: Interval[], now: Date): Promise<void> {
  if (e.type_code !== 'birthday_party') return;
  if (resource.type !== 'room_whole') throw new AppError('PARTY_RESOURCE_INVALID', 422, 'Праздник проходит только в комнате VR+PS4 целиком', { resourceType: resource.type });
  const s = await resolveSetting(db, 'event.party.min_minutes', { branchId: e.branch_id }, now);
  const minutes = durationMinutes(period);
  if (minutes < s.value) throw new AppError('PARTY_TOO_SHORT', 422, `Праздник – непрерывно не меньше ${s.value} минут`, { minMinutes: s.value });
  if (e.party_guests !== null) await assertPartyGuests(db, e.branch_id, e.party_guests, now);
  if (e.participants_count !== null) await assertPartyGuests(db, e.branch_id, e.participants_count, now);
  const fits =
    e.party_format === null ||
    (e.party_format === 'h2' && minutes === 120) ||
    (e.party_format === 'h3plus' && minutes >= 180) ||
    (e.party_format === 'full_day' && open.some((i) => i.start.getTime() === period.start.getTime() && i.end.getTime() === period.end.getTime()));
  if (!fits) throw new AppError('PARTY_FORMAT_MISMATCH', 422, 'Длительность не соответствует формату праздника', { format: e.party_format });
}

/** Все активные ресурсы мероприятия – под текущий формат и гостей. График как таковой не проверяется: занятость уже есть, а «весь день» считается по нему. */
export async function assertRoomsFitParty(db: Db, e: EventRow, now: Date): Promise<void> {
  if (e.type_code !== 'birthday_party') return;
  const rows = await db.query<{ resource_id: string; period: string }>(`SELECT resource_id, period::text FROM app.event_resources WHERE event_id = $1 AND status = 'active' ORDER BY lower(period), id`, [e.id]);
  for (const row of rows.rows) {
    const resource = await getResource(db, row.resource_id);
    if (!resource) continue;
    const period = fromPgRange(row.period);
    const open = await openIntervals(db, { branchId: e.branch_id, date: instantToLocal(period.start, e.timezone as TimeZone).date, roomId: resource.roomId, resourceId: resource.id });
    await assertPartyRules(db, e, resource, period, open, now);
  }
}
