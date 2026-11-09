// S4-72: задачи экспорта (K24 §7, §9). Два одинаковых запроса → одна задача; файл с настоящими данными по правам постановщика (маска телефона, формула в тексте);
// права пересматриваются при скачивании; после срока файла нет, статус expired; 200 001 строка – failed EXPORT_TOO_LARGE; одна задача на сотрудника, всего 2; отмена; зависшая.
import { mkdtemp, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import { noNetwork, type AccessContext } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type Clock } from '../../apps/api/src/core/time.ts';
import { withTx } from '../../apps/api/src/modules/clients/index.ts';
import { cancelExport, downloadExport, flattenRow, getExport, listExports, requestExport, runExportGc, startExportRunner, type ExportRunDeps } from '../../apps/api/src/modules/reports/export.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';
import { reportFixtures, type Fx } from '../helpers/reports.ts';

const NOW = '2026-11-20T05:00:00Z';
const clock = fixedClock(NOW);
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };
let db: TestDatabase;
let fx: Fx;
let dir: string;
let store: FileStore;
let run: ExportRunDeps;
let nsk: string;
let msk: string;
let directorId: string;
let otherId: string;
let phoneTail: string;

const meta = (ctx: AccessContext): AuditRequestMeta => ({ actor: ctx.actor, access: ctx, source: 'crm', requestId: randomUUID() });
const owner = () => fx.owner(new Date(NOW));
const asStaff = (id: string, branches: string[]): AccessContext => ({ ...fx.director(branches), actor: { kind: 'staff', staffId: id, sessionId: randomUUID() } });
const director = () => asStaff(directorId, [nsk]);
const request = (ctx: AccessContext, body: unknown) => withTx(fx.app, (tx) => requestExport(tx, ctx, body, meta(ctx), clock));
const drain = async () => {
  const runner = startExportRunner(run, { start: false });
  for (let i = 0; i < 4; i++) await runner.tick(); // по одной задаче на сотрудника за проход
  await runner.stop();
};
async function text(ctx: AccessContext, id: string): Promise<string> {
  const d = await downloadExport({ pool: fx.app, clock, store }, ctx, id, meta(ctx));
  const parts: Buffer[] = [];
  for await (const c of d.stream) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts).toString();
}
const auditCount = async (action: string, id: string) =>
  Number((await db.client.query<{ n: string }>(`SELECT count(*) AS n FROM journal.audit_events WHERE action = $1 AND object_id = $2`, [action, id])).rows[0]!.n);

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  fx = await reportFixtures(db);
  dir = await mkdtemp(join(tmpdir(), 'yu-export-'));
  store = createFileStore({ root: dir });
  run = { pool: fx.app, reports: fx.reports, clock, store, network: noNetwork, log: (e) => { throw e as Error; } };
  nsk = (await fx.branch('Asia/Novosibirsk')).id;
  msk = (await fx.branch('Europe/Moscow')).id;
  const pc = await fx.resource(nsk, 'pc', 'ПК-1', []);
  const pcM = await fx.resource(msk, 'pc', 'ПК-М', []);
  const ivan = await fx.client({ firstName: 'Иван', lastName: 'Петров' });
  phoneTail = (await db.client.query<{ p: string }>(`SELECT phone_e164 AS p FROM app.clients WHERE id = $1`, [ivan])).rows[0]!.p;
  const b = await fx.booking({ branchId: nsk, clientId: ivan, resourceId: pc, start: '2026-10-31T16:30:00Z', createdAt: '2026-10-20T05:00:00Z', priceKop: 150_050 });
  await fx.visit(b);
  await fx.visit(await fx.booking({ branchId: msk, clientId: ivan, resourceId: pcM, start: '2026-10-10T10:00:00Z' }));
  const mkStaff = async (key: string) => {
    const id = (await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Д', 'Д', $1, 'director', 'x') RETURNING id`, [`${key}@yu.test`])).rows[0]!.id;
    await db.client.query(`INSERT INTO app.staff_assignments (staff_id, scope_type, branch_id, valid_from, created_by) VALUES ($1, 'branch', $2, '2026-01-01', $1)`, [id, nsk]);
    return id;
  };
  directorId = await mkStaff('dir');
  otherId = await mkStaff('other');
}, 60_000);
afterAll(async () => {
  await fx.close();
  await rm(dir, { recursive: true, force: true });
  await db.drop();
});

describe('постановка', () => {
  it('два одинаковых запроса → одна задача, порядок фильтров не важен; другой формат или detail – другая; аудит один', async () => {
    const a = await request(owner(), { report: 'bookings', format: 'csv', params: { ...PERIOD, status: ['completed', 'confirmed'] } });
    const b = await request(owner(), { report: 'bookings', format: 'csv', params: { to: PERIOD.to, status: 'confirmed,completed', from: PERIOD.from } });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(await auditCount('export.requested', a.job.id)).toBe(1);
    const c = await request(owner(), { report: 'bookings', format: 'xlsx', params: { ...PERIOD, status: ['completed', 'confirmed'] } });
    expect(c.job.id).not.toBe(a.job.id);
    await withTx(fx.app, async (tx) => {
      await cancelExport(tx, owner(), a.job.id, meta(owner()), clock);
      await cancelExport(tx, owner(), c.job.id, meta(owner()), clock);
    });
  });

  it('длиннее экранных 92 дней – можно; неверный период, неизвестный отчёт, чужой филиал, нет права', async () => {
    const long = await request(owner(), { report: 'bookings', format: 'csv', params: { from: '2026-01-01', to: '2026-10-31' } });
    expect(long.job.status).toBe('queued');
    await withTx(fx.app, (tx) => cancelExport(tx, owner(), long.job.id, meta(owner()), clock));
    await expect(request(owner(), { report: 'bookings', format: 'csv', params: { from: '2026-10-31', to: '2026-10-01' } })).rejects.toMatchObject({ code: 'REPORT_PERIOD_INVALID' });
    await expect(request(owner(), { report: 'нет', format: 'csv', params: PERIOD })).rejects.toMatchObject({ code: 'REPORT_UNKNOWN' });
    const e3 = await request(owner(), { report: 'staff', format: 'csv', params: PERIOD }); // отчёты Э3 в реестре с S4-76…S4-78
    expect(e3.job.status).toBe('queued');
    await withTx(fx.app, (tx) => cancelExport(tx, owner(), e3.job.id, meta(owner()), clock));
    await expect(request(director(), { report: 'bookings', format: 'csv', params: { ...PERIOD, branchIds: [msk] } })).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    await expect(request(fx.admin([nsk]), { report: 'bookings', format: 'csv', params: PERIOD })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { action: 'reports.export' } });
    await expect(request(owner(), { report: 'bookings', format: 'csv', detail: true, params: PERIOD })).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
  });

  it('зона директора заморожена: параметры – его филиалы, а не «вся сеть»', async () => {
    const r = await request(director(), { report: 'bookings', format: 'csv', params: PERIOD });
    expect(r.job.params.branchIds).toEqual([nsk]);
    expect(r.job.masked).toBe(true);
    await withTx(fx.app, (tx) => cancelExport(tx, director(), r.job.id, meta(director()), clock));
  });
});

describe('файл', () => {
  it('детализация директора: только его филиал, телефон маской, суммы числом, дата в зоне филиала с годом; итог в шапке', async () => {
    const { job } = await request(director(), { report: 'bookings', format: 'csv', detail: true, params: { ...PERIOD, metric: 'visited' } });
    await drain();
    const done = await getExport(fx.app, director(), job.id);
    expect(done).toMatchObject({ status: 'ready', rows: 1, masked: true, errorCode: null });
    expect(done.expiresAt).toBe('2026-11-21T05:00:00.000Z'); // 24 ч, reports.export_ttl_hours
    const csv = await text(director(), job.id);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Отчёт;Бронирования и посещаемость');
    expect(csv).toContain('Сутки – по времени каждого филиала');
    expect(csv).toContain('Итого: Состоялось;1');
    expect(csv).toContain('1500,50');
    expect(csv).toContain('31.10.2026 23:30'); // 16:30 UTC = 23:30 НСК
    expect(csv).toContain('Иван Петров'); // client.view.full у директора
    expect(csv).toMatch(/\+7 ••• ••• ••-\d\d/);
    expect(csv).not.toContain(phoneTail);
    expect(csv).not.toContain('ПК-М');
    expect(await auditCount('export.downloaded', job.id)).toBe(1);
  });

  it('Владелец с export.pd: полный телефон, оба филиала; XLSX – настоящий файл', async () => {
    const { job } = await request(owner(), { report: 'bookings', format: 'csv', detail: true, params: { ...PERIOD, metric: 'visited' } });
    await drain();
    expect(await getExport(fx.app, owner(), job.id)).toMatchObject({ status: 'ready', rows: 2, masked: false });
    const csv = await text(owner(), job.id);
    expect(csv).toContain(phoneTail);
    expect(csv).toContain('ПК-М');
    const x = await request(owner(), { report: 'bookings', format: 'xlsx', params: PERIOD });
    await drain();
    const ready = await getExport(fx.app, owner(), x.job.id);
    expect(ready.status).toBe('ready');
    const d = await downloadExport({ pool: fx.app, clock, store }, owner(), x.job.id, meta(owner()));
    expect(d.fileName).toBe('yu-club-bookings-2026-10-01-2026-10-31.xlsx');
    expect(d.mime).toContain('spreadsheetml');
    const head: Buffer[] = [];
    for await (const c of d.stream) head.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(head).subarray(0, 2).toString()).toBe('PK');
  });

  it('агрегат: показатели строками, «нет данных» – словами, не нулём', async () => {
    const { job } = await request(owner(), { report: 'bookings', format: 'csv', params: { from: '2020-01-01', to: '2020-01-31' } });
    await drain();
    const csv = await text(owner(), job.id);
    expect(csv).toContain('Показатель;Значение;Единица;Прошлый период;Изменение, %;Основа даты');
    expect(csv).toContain('Создано;нет данных');
  });

  it('сводка – файлом по карточкам', async () => {
    const { job } = await request(owner(), { report: 'dashboard', format: 'csv', params: PERIOD });
    await drain();
    const csv = await text(owner(), job.id);
    expect(csv).toContain('Поступления от сеансов');
    expect(csv).toContain('Состоялось посещений;2;шт.');
  });

  it('flattenRow: комментарий только с правом; маска только полного номера', () => {
    const row = { comment: 'служебное', client: { id: 'c', kind: 'profile', name: 'И', phone: '+79131234567' }, ok: true, list: ['a', 'b'] };
    expect(flattenRow(row, { masked: true, comments: false })).toEqual({ clientId: 'c', clientName: 'И', clientPhone: '+7 ••• ••• ••-67', ok: 'да', list: 'a, b' });
    expect(flattenRow(row, { masked: false, comments: true })).toMatchObject({ comment: 'служебное', clientPhone: '+79131234567' });
  });
});

describe('права при скачивании и чужие', () => {
  it('чужая задача – 404; не готова – 409; зона сузилась – 403', async () => {
    const { job } = await request(director(), { report: 'bookings', format: 'csv', params: PERIOD });
    await expect(getExport(fx.app, asStaff(otherId, [nsk]), job.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(downloadExport({ pool: fx.app, clock, store }, asStaff(otherId, [nsk]), job.id, meta(director()))).rejects.toMatchObject({ httpStatus: 404 });
    await expect(downloadExport({ pool: fx.app, clock, store }, director(), job.id, meta(director()))).rejects.toMatchObject({ code: 'EXPORT_NOT_READY', httpStatus: 409 });
    await drain();
    expect((await getExport(fx.app, director(), job.id)).status).toBe('ready');
    await expect(downloadExport({ pool: fx.app, clock, store }, asStaff(directorId, [msk]), job.id, meta(director()))).rejects.toMatchObject({ code: 'EXPORT_FORBIDDEN', httpStatus: 403 });
    await expect(downloadExport({ pool: fx.app, clock, store }, { ...director(), role: 'admin' }, job.id, meta(director()))).rejects.toMatchObject({ code: 'EXPORT_FORBIDDEN' });
    await text(director(), job.id);
  });

  it('файл без маски не отдаётся, если export.pd потеряно; файл на сеть – если сети больше нет', async () => {
    const { job } = await request(owner(), { report: 'bookings', format: 'csv', params: { ...PERIOD, resourceType: ['pc'] } });
    await drain();
    await expect(downloadExport({ pool: fx.app, clock, store }, { ...fx.director([nsk, msk]) }, job.id, meta(owner()))).rejects.toMatchObject({ code: 'EXPORT_FORBIDDEN' });
  });

  it('сотрудника заблокировали до расчёта – failed, файла нет, аудит export.failed', async () => {
    const { job } = await request(asStaff(otherId, [nsk]), { report: 'bookings', format: 'csv', params: PERIOD });
    await db.client.query(`UPDATE app.staff SET status = 'blocked' WHERE id = $1`, [otherId]);
    await drain();
    await db.client.query(`UPDATE app.staff SET status = 'active' WHERE id = $1`, [otherId]);
    expect(await getExport(fx.app, asStaff(otherId, [nsk]), job.id)).toMatchObject({ status: 'failed', errorCode: 'EXPORT_FORBIDDEN' });
    expect(await auditCount('export.failed', job.id)).toBe(1);
  });
});

describe('очередь', () => {
  const queued = async (staff: string, tag: string) =>
    (await db.client.query<{ id: string }>(`INSERT INTO app.report_exports (staff_id, report, format, params, params_hash, detail, masked, created_at) VALUES ($1, 'bookings', 'csv', $2, $3, false, true, $4) RETURNING id`, [
      staff, JSON.stringify({ ...PERIOD, branchIds: [nsk] }), tag, NOW,
    ])).rows[0]!.id;
  const status = async (id: string) => (await db.client.query<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM app.report_exports WHERE id = $1`, [id])).rows[0]!;

  it('одна на сотрудника: две задачи одного – по очереди; всего не больше двух', async () => {
    const a1 = await queued(directorId, 'q1');
    const a2 = await queued(directorId, 'q2');
    const b1 = await queued(otherId, 'q3');
    const runner = startExportRunner(run, { start: false });
    await runner.tick(); // по одной на сотрудника: вторая задача того же сотрудника ждёт
    expect((await status(b1)).status).toBe('ready');
    expect([(await status(a1)).status, (await status(a2)).status].sort()).toEqual(['queued', 'ready']);
    await runner.tick();
    expect((await status(a1)).status).toBe('ready');
    expect((await status(a2)).status).toBe('ready');
    await runner.stop();
  });

  it('отмена очереди – файла нет, cancelled, аудит; завершённую отмена не меняет', async () => {
    const ctx = director();
    const { job } = await request(ctx, { report: 'loyalty', format: 'csv', params: PERIOD });
    const c = await withTx(fx.app, (tx) => cancelExport(tx, ctx, job.id, meta(ctx), clock));
    expect(c.status).toBe('cancelled');
    expect(await auditCount('export.cancelled', job.id)).toBe(1);
    const again = await withTx(fx.app, (tx) => cancelExport(tx, ctx, job.id, meta(ctx), clock));
    expect(again.status).toBe('cancelled');
    expect(await auditCount('export.cancelled', job.id)).toBe(1);
    await drain();
    expect((await getExport(fx.app, ctx, job.id)).status).toBe('cancelled');
  });

  it('зависшая running после смерти процесса – failed EXPORT_INTERRUPTED, очередь свободна', async () => {
    const id = await queued(directorId, 'stale');
    await db.client.query(`UPDATE app.report_exports SET status = 'running', started_at = $2 WHERE id = $1`, [id, new Date(Date.parse(NOW) - 3_600_000)]);
    await drain();
    expect(await status(id)).toEqual({ status: 'failed', error_code: 'EXPORT_INTERRUPTED' });
  });

  it('ошибка в файле: неизвестный показатель – failed с кодом, не молчание', async () => {
    const { job } = await request(owner(), { report: 'bookings', format: 'csv', detail: true, params: { ...PERIOD, metric: 'нет-такого' } });
    await drain();
    expect(await getExport(fx.app, owner(), job.id)).toMatchObject({ status: 'failed', errorCode: 'REPORT_FILTER_INVALID' });
  });

  it('свои задачи списком новые сверху с курсором; только свои', async () => {
    const page = await listExports(fx.app, director());
    expect(page.items.length).toBeGreaterThan(1);
    expect(new Set(page.items.map((i) => i.id)).size).toBe(page.items.length);
    expect(page.nextCursor).toBeNull();
    await expect(listExports(fx.app, director(), { cursor: 'мусор' })).rejects.toMatchObject({ code: 'REPORT_FILTER_INVALID' });
    await expect(listExports(fx.app, fx.admin([nsk]))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('уборка reports:export-gc', () => {
  it('после срока файла нет, статус expired, скачивание 410; новый запрос – новая задача; осиротевшие и временные стираются по возрасту', async () => {
    const { job } = await request(owner(), { report: 'finance', format: 'csv', params: PERIOD });
    await drain();
    const key = (await db.client.query<{ file_key: string }>(`SELECT file_key FROM app.report_exports WHERE id = $1`, [job.id])).rows[0]!.file_key;
    expect(await store.exists(key)).toBe(true);
    const before: Clock = fixedClock('2026-11-21T04:59:00Z');
    expect((await runExportGc({ pool: fx.app, clock: before, store })).expired).toBe(0);
    expect(await store.exists(key)).toBe(true);
    const old = new Date('2026-11-01T00:00:00Z');
    await writeFile(join(dir, randomUUID()), 'осиротевший');
    const orphan = (await readdir(dir)).find((f) => f !== key && !f.startsWith('.'));
    await mkdir(join(dir, '.tmp'), { recursive: true });
    await writeFile(join(dir, '.tmp', 'a.part'), 'x');
    await utimes(join(dir, '.tmp', 'a.part'), old, old);
    await utimes(join(dir, orphan!), old, old);
    const after = fixedClock('2026-11-21T05:00:00Z');
    const gc = await runExportGc({ pool: fx.app, clock: after, store });
    expect(gc.expired).toBeGreaterThan(0);
    expect(gc.orphans).toBeGreaterThan(0);
    expect(await store.exists(key)).toBe(false);
    expect(await readdir(join(dir, '.tmp'))).not.toContain('a.part');
    expect(await getExport(fx.app, owner(), job.id)).toMatchObject({ status: 'expired' });
    await expect(downloadExport({ pool: fx.app, clock: after, store }, owner(), job.id, meta(owner()))).rejects.toMatchObject({ code: 'EXPORT_EXPIRED', httpStatus: 410 });
    const fresh = await request(owner(), { report: 'finance', format: 'csv', params: PERIOD });
    expect(fresh.created).toBe(true);
    expect(fresh.job.id).not.toBe(job.id);
  });

  it('файл пропал при ready: 410, строка → expired без file_key, аудит export.expired один раз; повторный запрос – новая задача', async () => {
    const { job } = await request(owner(), { report: 'certificates', format: 'csv', params: PERIOD });
    await drain();
    const key = (await db.client.query<{ file_key: string }>(`SELECT file_key FROM app.report_exports WHERE id = $1`, [job.id])).rows[0]!.file_key;
    await store.remove(key);
    for (let i = 0; i < 2; i++) {
      await expect(downloadExport({ pool: fx.app, clock, store }, owner(), job.id, meta(owner()))).rejects.toMatchObject({ code: 'EXPORT_EXPIRED', httpStatus: 410 });
    }
    const row = (await db.client.query<{ status: string; file_key: string | null }>(`SELECT status, file_key FROM app.report_exports WHERE id = $1`, [job.id])).rows[0]!;
    expect(row).toEqual({ status: 'expired', file_key: null });
    expect(await auditCount('export.expired', job.id)).toBe(1);
    const again = await request(owner(), { report: 'certificates', format: 'csv', params: PERIOD });
    expect(again.job.id).not.toBe(job.id);
  });

  it('срок прошёл, уборки ещё не было: скачивание 410, повторный запрос – новая задача', async () => {
    const { job } = await request(owner(), { report: 'clients', format: 'csv', params: PERIOD });
    await drain();
    await db.client.query(`UPDATE app.report_exports SET expires_at = $2 WHERE id = $1`, [job.id, new Date(Date.parse(NOW) - 1000)]);
    await expect(downloadExport({ pool: fx.app, clock, store }, owner(), job.id, meta(owner()))).rejects.toMatchObject({ code: 'EXPORT_EXPIRED' });
    const again = await request(owner(), { report: 'clients', format: 'csv', params: PERIOD });
    expect(again.job.id).not.toBe(job.id);
    expect((await getExport(fx.app, owner(), job.id)).status).toBe('expired');
  });
});
