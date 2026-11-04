// S3-01b: ядро принимает объекты аудита Э3 (K2 «Э3») и коды вложений 413/415 (K19 §15, D3-07).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_OBJECT_TYPES, writeAudit, type AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError, coreErrors } from '../../apps/api/src/core/errors.ts';
import { errorStatus } from '../../apps/api/src/core/registry.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const E3_OBJECTS = [
  'shift', 'staff_rate', 'payroll_period', 'payroll_statement', 'payroll_penalty',
  'equipment', 'equipment_account', 'equipment_category', 'repair', 'repair_executor', 'warranty', 'attachment',
  'event', 'event_type', 'event_package', 'gift', 'holiday', 'staff_grant',
] as const;

const meta: AuditRequestMeta = {
  actor: { kind: 'staff', staffId: '11111111-1111-4111-8111-111111111111', sessionId: 's1' },
  access: { role: 'owner', network: true, cityIds: new Set(), branchIds: new Set() },
  source: 'crm',
  requestId: 'req-e3',
};
const clock = fixedClock('2026-11-15T07:00:00Z');

describe('S3-01b: типы ядра Э3', () => {
  let db: TestDatabase;
  let app: pg.Pool;
  beforeAll(async () => {
    db = await createTestDatabase({ migrate: true });
    app = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 2 });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it('объекты Э3 из K2 – в реестре', () => {
    for (const t of E3_OBJECTS) expect(AUDIT_OBJECT_TYPES, t).toContain(t);
  });

  it('writeAudit пишет объект Э3 и отвергает неизвестный', async () => {
    await writeAudit(app, meta, { action: 'shift.created', object: { type: 'shift', id: '33333333-3333-4333-8333-333333333333' } }, clock);
    const r = await app.query<{ object_type: string }>(`SELECT object_type FROM journal.audit_events WHERE action = 'shift.created'`);
    expect(r.rows.map((x) => x.object_type)).toEqual(['shift']);
    await expect(
      // @ts-expect-error – тип объекта вне реестра K2
      writeAudit(app, meta, { action: 'shift.created', object: { type: 'shift_template', id: null } }, clock),
    ).rejects.toThrow(/неизвестный тип объекта/);
  });

  it('коды вложений: 413 и 415 в ядре и в реестре HTTP-статусов', () => {
    expect(coreErrors.ATTACHMENT_TOO_LARGE).toBe(413);
    expect(coreErrors.ATTACHMENT_TYPE_NOT_ALLOWED).toBe(415);
    expect(errorStatus.ATTACHMENT_TOO_LARGE).toBe(413);
    expect(errorStatus.ATTACHMENT_TYPE_NOT_ALLOWED).toBe(415);
    const e = new AppError('ATTACHMENT_TOO_LARGE', 413, 'Файл больше лимита');
    expect(e.httpStatus).toBe(413);
  });
});
