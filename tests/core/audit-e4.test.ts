// S4-02: типы объектов аудита Э4 (K2 «Типы объектов Э4») и HTTP-статусы ядра для кодов K22 §14, K24 §10 (D4-07).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_OBJECT_TYPES, writeAudit, type AuditObjectType, type AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError, type HttpStatus } from '../../apps/api/src/core/errors.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const STAFF_ID = '11111111-1111-4111-8111-1111111111e4';
const OBJECT_ID = '33333333-3333-4333-8333-3333333333e4';
const clock = fixedClock('2026-11-15T07:00:00Z');
const meta: AuditRequestMeta = {
  actor: { kind: 'staff', staffId: STAFF_ID, sessionId: 's-e4' },
  access: { role: 'owner', network: true, cityIds: new Set(), branchIds: new Set() },
  source: 'crm',
  requestId: 'req-e4',
};

const E4_TYPES = [
  'notification_campaign',
  'notification_template',
  'publication',
  'game',
  'room_page',
  'branch_page',
  'content_page',
  'home_block',
  'media',
] as const satisfies readonly AuditObjectType[];

describe('S4-02: аудит Э4', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('типы объектов Э4 есть в реестре, типы Э0–Э2 на месте', () => {
    for (const t of E4_TYPES) expect(AUDIT_OBJECT_TYPES).toContain(t);
    for (const t of ['notification', 'export', 'client', 'payment']) expect(AUDIT_OBJECT_TYPES).toContain(t);
  });

  it.each(E4_TYPES)('запись объекта %s проходит', async (type) => {
    await writeAudit(db.client, meta, { action: 'content.published', object: { type, id: OBJECT_ID }, after: { versionNo: 1 } }, clock);
    const r = await db.client.query('SELECT count(*)::int AS n FROM journal.audit_events WHERE object_type = $1 AND object_id = $2', [type, OBJECT_ID]);
    expect(r.rows[0].n).toBe(1);
  });

  it('неизвестный тип объекта – ошибка, строки нет', async () => {
    await expect(
      writeAudit(db.client, meta, { action: 'content.published', object: { type: 'content_draft' as AuditObjectType, id: OBJECT_ID } }, clock),
    ).rejects.toThrow(/неизвестный тип объекта content_draft/);
    const r = await db.client.query("SELECT count(*)::int AS n FROM journal.audit_events WHERE object_type = 'content_draft'");
    expect(r.rows[0].n).toBe(0);
  });

  it('client.searched: телефон запроса в аудите – маской (K24 §5)', async () => {
    const id = '44444444-4444-4444-8444-4444444444e4';
    await writeAudit(db.client, meta, { action: 'client.searched', object: { type: 'client', id }, after: { phone: '+79991234567', results: 1 } }, clock);
    const r = await db.client.query<{ after: { phone: string; results: number } }>('SELECT after FROM journal.audit_events WHERE object_id = $1', [id]);
    expect(r.rows[0]!.after).toEqual({ phone: '+7******4567', results: 1 });
  });

  it('HTTP-статусы 413, 415, 504, 507 принимаются AppError (D4-07)', () => {
    const statuses: HttpStatus[] = [413, 415, 504, 507];
    for (const s of statuses) expect(new AppError('INTERNAL', s, 'x').httpStatus).toBe(s);
  });
});
