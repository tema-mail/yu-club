// S2-06: реестр способов оплаты (K10 §5) и события payment.recorded / payment.refunded (K10 §6, K4) с агрегатом payment.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSubscriptions, processEvent, publish, subscribe, type EventEnvelope } from '../../apps/api/src/core/outbox.ts';
import {
  clearPaymentMethods,
  paymentMethodHandler,
  registeredPaymentMethods,
  registerPaymentMethod,
  type PaymentMethod,
  type PaymentMethodHandler,
} from '../../apps/api/src/modules/finance/methods.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const stub = (method: PaymentMethodHandler['method']): PaymentMethodHandler => ({
  method,
  charge: async (_tx, input) => ({ postingId: randomUUID(), amountKop: input.amountKop }),
  refund: async () => ({ postingId: null, outcome: 'not_restored' }),
});

describe('реестр способов оплаты', () => {
  it('регистрация, поиск, список подключённых', () => {
    clearPaymentMethods();
    registerPaymentMethod(stub('points'));
    registerPaymentMethod(stub('certificate'));
    expect(paymentMethodHandler('points')?.method).toBe('points');
    expect(paymentMethodHandler('cash')).toBeUndefined();
    expect(registeredPaymentMethods()).toEqual(['points', 'certificate']);
  });

  it('дубль способа – ошибка при старте; неизвестный способ и none – тоже', () => {
    expect(() => registerPaymentMethod(stub('points'))).toThrow(/уже зарегистрирован/);
    expect(() => registerPaymentMethod(stub('none' as never))).toThrow(/неизвестный способ/);
    expect(() => registerPaymentMethod(stub('bitcoin' as never))).toThrow(/неизвестный способ/);
  });
});

describe('события payment.* через outbox', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  });
  afterAll(async () => {
    clearSubscriptions();
    await pool.end();
    await db.drop();
  });

  it('обработчик-заглушка получает типизированный payload; агрегат payment пишется в outbox', async () => {
    const seen: { methods: PaymentMethod[]; total: number; sessionStatus?: string }[] = [];
    subscribe('payment.recorded', 'test.loyalty.accrual', async (_tx, e: EventEnvelope<'payment.recorded'>) => {
      // типы проверяет компилятор (npm run typecheck): поля K10 §6
      const methods: PaymentMethod[] = e.payload.methods;
      const pts: number | null = e.payload.pointsCenti;
      // @ts-expect-error – в payload нет ПДн (K4 правило 2)
      void e.payload.phone;
      seen.push({ methods, total: e.payload.totalKop + (pts ?? 0) });
    });
    subscribe('payment.refunded', 'test.loyalty.refund', async (_tx, e) => {
      seen.push({ methods: e.payload.lines.map((l) => l.method), total: e.payload.lines[0]!.amountKop, sessionStatus: e.payload.sessionStatus });
    });

    const paymentId = randomUUID();
    const bookingId = randomUUID();
    const c = await pool.connect();
    let recorded: string;
    let refunded: string;
    try {
      await c.query('BEGIN');
      recorded = (
        await publish(c, {
          type: 'payment.recorded', aggregateType: 'payment', aggregateId: paymentId, aggregateVersion: paymentId, branchId: null, occurredAt: new Date(),
          payload: { paymentId, sessionId: bookingId, bookingId, branchId: randomUUID(), clientId: randomUUID(), attempt: 1, methods: ['cash'], totalKop: 50000, pointsCenti: null, certificateId: null },
        })
      ).eventId;
      const refundId = randomUUID();
      refunded = (
        await publish(c, {
          type: 'payment.refunded', aggregateType: 'payment', aggregateId: paymentId, aggregateVersion: refundId, branchId: null, occurredAt: new Date(),
          payload: { refundId, paymentId, bookingId, clientId: randomUUID(), lines: [{ lineNo: 1, method: 'cash', amountKop: 50000, pointsCenti: null, outcome: 'returned' }], reason: 'ошибка способа', sessionStatus: 'refunded' },
        })
      ).eventId;
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const rows = await pool.query(`SELECT event_type, aggregate_type FROM app.outbox_events ORDER BY event_type`);
    expect(rows.rows).toEqual([
      { event_type: 'payment.recorded', aggregate_type: 'payment' },
      { event_type: 'payment.refunded', aggregate_type: 'payment' },
    ]);
    expect(await processEvent(pool, 'test.loyalty.accrual', recorded, new Date())).toBe('processed');
    expect(await processEvent(pool, 'test.loyalty.refund', refunded, new Date())).toBe('processed');
    expect(await processEvent(pool, 'test.loyalty.accrual', recorded, new Date())).toBe('duplicate');
    expect(seen).toEqual([
      { methods: ['cash'], total: 50000 },
      { methods: ['cash'], total: 50000, sessionStatus: 'refunded' },
    ]);
  });
});
