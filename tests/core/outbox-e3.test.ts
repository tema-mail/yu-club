// S3-08: события Э3 (K4 «События этапа 3», K18 §11, K19 §11, K20 §12). Схемы payload – Zod, строгие;
// тип payload проверяется компилятором в обработчике-заглушке; публикация с агрегатами Э3 идёт в outbox как обычно.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSubscriptions, publish, subscribe, type AggregateType, type EventPayload } from '../../apps/api/src/core/outbox.ts';
import { E3_AGGREGATE_TYPES, E3_EVENT_SCHEMAS, parseE3Payload, type E3EventType } from '../../packages/contracts/src/events-e3.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const id = () => randomUUID();
const AT = '2026-11-14T05:00:00.000Z';
const END = '2026-11-14T09:00:00.000Z';

const SAMPLES: { [T in E3EventType]: EventPayload<T> } = {
  'shift.changed': {
    shiftId: id(), staffId: id(), branchId: id(), branchTimezone: 'Asia/Novosibirsk', changedBy: id(), kind: 'updated',
    before: { start: AT, end: END, branchId: id() }, after: { start: AT, end: END, branchId: id() }, reason: 'замена',
  },
  'shift.attendance_changed': { shiftId: id(), staffId: id(), branchId: id(), localDate: '2026-11-14', factVersion: 2 },
  'staff.rate_set': { rateId: id(), staffId: id(), validFrom: '2026-11-01', affectedShiftIds: [id()] },
  'repair.registered': { repairId: id(), number: 'R-000001', equipmentId: id(), branchId: id(), priority: 'critical', impact: 'partial', autoBlockId: null },
  'repair.closed': { repairId: id(), branchId: id(), finalEquipmentStatus: 'in_service', stillBlockedIds: [] },
  'event.confirmed': { eventId: id(), number: 'E-000001', branchId: id(), branchTimezone: 'Asia/Novosibirsk', customerClientId: null, plannedStart: AT, plannedEnd: END },
  'event.rescheduled': { eventId: id(), branchId: id(), customerClientId: id(), previous: { start: AT, end: END }, current: { start: AT, end: END } },
  'event.cancelled': { eventId: id(), branchId: id(), customerClientId: null, reason: 'заказчик отказался', linkedBookingIds: [id()], giftIds: [] },
  'gift.issued': { giftId: id(), clientId: id(), validUntil: '2026-07-31', issueBranchId: id() },
};

describe('S3-08: схемы событий Э3', () => {
  it('9 событий K4 «Э3» – каждое разбирается своей схемой', () => {
    expect(Object.keys(E3_EVENT_SCHEMAS).sort()).toEqual(
      ['event.cancelled', 'event.confirmed', 'event.rescheduled', 'gift.issued', 'repair.closed', 'repair.registered', 'shift.attendance_changed', 'shift.changed', 'staff.rate_set'],
    );
    for (const [type, payload] of Object.entries(SAMPLES)) expect(parseE3Payload(type as E3EventType, payload), type).toEqual(payload);
  });

  it('строгие схемы: лишнее поле (сумма, телефон) и неверное значение отвергаются', () => {
    expect(() => parseE3Payload('shift.attendance_changed', { ...SAMPLES['shift.attendance_changed'], accrualKop: 120_000 })).toThrow();
    expect(() => parseE3Payload('event.confirmed', { ...SAMPLES['event.confirmed'], customerPhone: '+79990000000' })).toThrow();
    expect(() => parseE3Payload('repair.closed', { ...SAMPLES['repair.closed'], finalEquipmentStatus: 'broken' })).toThrow();
    expect(() => parseE3Payload('shift.attendance_changed', { ...SAMPLES['shift.attendance_changed'], factVersion: 0 })).toThrow();
    expect(() => parseE3Payload('gift.issued', { ...SAMPLES['gift.issued'], validUntil: '31.07.2026' })).toThrow();
  });

  it('тип payload проверяется компилятором в обработчике-заглушке', () => {
    subscribe('shift.attendance_changed', 'test.e3.stub', async (_tx, e) => {
      const version: number = e.payload.factVersion;
      const date: string = e.payload.localDate;
      // @ts-expect-error – суммы в событии нет (K18 §10, K4 правило 2)
      void e.payload.accrualKop;
      void version;
      void date;
    });
    subscribe('gift.issued', 'test.e3.gift', async (_tx, e) => {
      const until: string = e.payload.validUntil;
      void until;
    });
    expect(listSubscriptions().map((s) => s.name)).toEqual(expect.arrayContaining(['test.e3.stub', 'test.e3.gift']));
    const agg: AggregateType[] = [...E3_AGGREGATE_TYPES];
    expect(agg).toEqual(['shift', 'staff_rate', 'repair', 'event', 'gift']);
  });
});

describe('S3-08: публикация с агрегатами Э3', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 2 });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it('publish пишет событие Э3 в outbox; повтор того же факта – та же строка', async () => {
    const payload = SAMPLES['shift.attendance_changed'];
    const input = {
      type: 'shift.attendance_changed' as const,
      aggregateType: 'shift' as const,
      aggregateId: payload.shiftId,
      aggregateVersion: payload.factVersion,
      branchId: payload.branchId,
      payload,
      occurredAt: new Date(AT),
    };
    const a = await publish(pool, input);
    const b = await publish(pool, input);
    expect(b.eventId).toBe(a.eventId);
    const r = await pool.query<{ aggregate_type: string; payload: unknown }>(`SELECT aggregate_type, payload FROM app.outbox_events WHERE id = $1`, [a.eventId]);
    expect(r.rows).toEqual([{ aggregate_type: 'shift', payload }]);
  });
});
