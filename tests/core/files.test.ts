// S3-06: адаптер диска ядра (core/files.ts) и закрытые вложения (0302, K19 §9).
// Лимит 10 МБ + 1 байт → ATTACHMENT_TOO_LARGE; .exe с подменой MIME → ATTACHMENT_TYPE_NOT_ALLOWED (сигнатура);
// путь из имени файла не принимается; обрыв посреди записи не оставляет файла под итоговым именем;
// UPDATE содержимого и DELETE от yu_app → 42501; «недействителен» хранит причину; версия вместо замены.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import {
  addAttachment,
  createFileStore,
  displayName,
  getAttachment,
  invalidateAttachment,
  listAttachments,
  registerAttachmentOwner,
  safeJoin,
  sniffType,
  UnsafePathError,
  type FileStore,
} from '../../apps/api/src/core/files.ts';
import { assertCan, type AccessContext, type StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const BR_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_B = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%тест\n');
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0]);

let db: TestDatabase;
let pool: pg.Pool;
let root: string;
let store: FileStore;
/** Владелец «test_repair»: объект – филиал по таблице ниже; чтение – equipment.view, запись – repair.attach. */
const repairs = new Map<string, string>();

function ctx(role: StaffRole, branchIds: string[] = []): AccessContext {
  return {
    actor: { kind: 'staff', staffId: randomUUID(), sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: clock.now(),
  };
}
const owner = ctx('owner');
const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });

async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}
const newRepair = (branchId = BR_A) => {
  const id = randomUUID();
  repairs.set(id, branchId);
  return id;
};
async function tx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
const add = (ownerId: string, content: Uint8Array | AsyncIterable<Uint8Array>, extra: Record<string, unknown> = {}, who = owner) =>
  tx((t) => addAttachment(t, who, store, { ownerType: 'test_repair', ownerId, docType: 'photo', content, ...extra }, meta(who), clock));
const invalidate = (id: string, reason: string) => tx((t) => invalidateAttachment(t, owner, id, { reason }, meta(owner), clock));

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  root = await mkdtemp(path.join(os.tmpdir(), 'yu-attachments-'));
  store = createFileStore({ root });
  const branchOf = (id: string) => {
    const b = repairs.get(id);
    if (!b) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return b;
  };
  registerAttachmentOwner('test_repair', {
    canRead: async (_db, c, id) => assertCan(c, 'equipment.view', { branchId: branchOf(id) }),
    canWrite: async (_db, c, id) => assertCan(c, 'repair.attach', { branchId: branchOf(id) }),
  });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('адаптер диска', () => {
  it('тип – по сигнатуре: PNG, JPEG, PDF распознаются, MZ (exe) – нет', () => {
    expect(sniffType(PNG)).toBe('image/png');
    expect(sniffType(JPEG)).toBe('image/jpeg');
    expect(sniffType(PDF)).toBe('application/pdf');
    expect(sniffType(EXE)).toBeNull();
    expect(sniffType(new Uint8Array())).toBeNull();
  });

  it('безопасный путь: «..», абсолютный, обратная косая, нулевой байт – отказ; итог внутри корня', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a\0b', '', '.', 'a//b', '.hidden/../..']) {
      expect(() => safeJoin(root, bad), JSON.stringify(bad)).toThrow(UnsafePathError);
    }
    expect(safeJoin(root, 'ab/cd.pdf')).toBe(path.join(root, 'ab', 'cd.pdf'));
  });

  it('адрес по sha256: одинаковое содержимое – один файл', async () => {
    const a = await store.putContent(PDF, { maxBytes: 1000, allowedTypes: [] });
    const b = await store.putContent(PDF, { maxBytes: 1000, allowedTypes: [] });
    expect(a.storageKey).toBe(b.storageKey);
    expect(a.storageKey).toBe(`${a.sha256.slice(0, 2)}/${a.sha256}`);
    expect(Buffer.compare(await store.read(a.storageKey), Buffer.from(PDF))).toBe(0);
  });

  it('обрыв посреди записи: под итоговым именем файла нет, временный удалён', async () => {
    async function* broken(): AsyncIterable<Uint8Array> {
      yield PNG;
      throw new Error('обрыв связи');
    }
    await expect(store.writeAtomic('exports/report.csv', broken())).rejects.toThrow('обрыв связи');
    expect(await store.exists('exports/report.csv')).toBe(false);
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
    // прежний файл под тем же именем при обрыве не портится
    await store.writeAtomic('exports/report.csv', new TextEncoder().encode('v1'));
    await expect(store.writeAtomic('exports/report.csv', broken())).rejects.toThrow('обрыв связи');
    expect((await store.read('exports/report.csv')).toString()).toBe('v1');
  });

  it('лимит – по ходу записи: лишнее на диск не попадает', async () => {
    async function* big(): AsyncIterable<Uint8Array> {
      yield PNG;
      yield new Uint8Array(100);
    }
    await fails(store.putContent(big(), { maxBytes: 50, allowedTypes: [] }), 'ATTACHMENT_TOO_LARGE');
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
  });
});

describe('вложения (0302)', () => {
  it('10 МБ + 1 байт → ATTACHMENT_TOO_LARGE; ровно 10 МБ – проходит', async () => {
    const r = newRepair();
    const limit = 10 * 1024 * 1024;
    const over = new Uint8Array(limit + 1);
    over.set(PDF);
    await fails(add(r, over, { docType: 'receipt' }), 'ATTACHMENT_TOO_LARGE');
    const exact = over.subarray(0, limit);
    const ok = await add(r, exact, { docType: 'receipt', declaredType: 'application/pdf' });
    expect(ok).toMatchObject({ sizeBytes: limit, mimeType: 'application/pdf', status: 'active' });
  });

  it('.exe с подменой MIME → ATTACHMENT_TYPE_NOT_ALLOWED; PNG, заявленный как PDF, – тоже', async () => {
    const r = newRepair();
    await fails(add(r, EXE, { declaredType: 'image/png', originalName: 'фото.png' }), 'ATTACHMENT_TYPE_NOT_ALLOWED');
    await fails(add(r, PNG, { declaredType: 'application/pdf' }), 'ATTACHMENT_TYPE_NOT_ALLOWED');
    expect(await listAttachments(pool, owner, 'test_repair', r)).toEqual([]);
  });

  it('путь из имени файла не принимается: имя – только подпись, файл лежит по sha256 внутри корня', async () => {
    const r = newRepair();
    const a = await add(r, JPEG, { originalName: '../../etc/passwd' });
    expect(a.originalName).toBe('passwd');
    const { storageKey } = await getAttachment(pool, owner, a.id);
    expect(store.pathOf(storageKey).startsWith(root + path.sep)).toBe(true);
    expect(await store.exists(storageKey)).toBe(true);
    expect(displayName('..')).toBeNull();
    expect(displayName('C:\\Users\\a\\чек.pdf')).toBe('чек.pdf');
  });

  it('UPDATE содержимого и DELETE от yu_app → 42501', async () => {
    const a = await add(newRepair(), PNG);
    await expect(pool.query(`UPDATE app.attachments SET storage_key = storage_key WHERE id = $1`, [a.id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query(`UPDATE app.attachments SET owner_id = gen_random_uuid() WHERE id = $1`, [a.id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query(`DELETE FROM app.attachments WHERE id = $1`, [a.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('«недействителен» хранит причину; без причины – COMMENT_REQUIRED; файл и строка остаются', async () => {
    const a = await add(newRepair(), PNG);
    await fails(invalidate(a.id, '  '), 'COMMENT_REQUIRED');
    const inv = await invalidate(a.id, 'фото не того шлема');
    expect(inv).toMatchObject({ status: 'invalid', invalidReason: 'фото не того шлема' });
    const again = await invalidate(a.id, 'другая');
    expect(again.invalidReason).toBe('фото не того шлема');
    const audit = await db.client.query(`SELECT reason FROM journal.audit_events WHERE action = 'attachment.invalidated' AND object_id = $1`, [a.id]);
    expect(audit.rows).toEqual([{ reason: 'фото не того шлема' }]);
  });

  it('версия вместо замены: прежняя строка цела, у версии один наследник', async () => {
    const r = newRepair();
    const v1 = await add(r, PNG, { docType: 'act' });
    const v2 = await add(r, PDF, { docType: 'act', supersedes: v1.id });
    expect(v2.supersedes).toBe(v1.id);
    await fails(add(r, JPEG, { docType: 'act', supersedes: v1.id }), 'VERSION_CONFLICT');
    const list = await listAttachments(pool, owner, 'test_repair', r);
    expect(list.map((x) => x.id).sort()).toEqual([v1.id, v2.id].sort());
    await fails(add(newRepair(), JPEG, { supersedes: v1.id }), 'NOT_FOUND'); // версия чужого объекта
  });

  it('право владельца: чужой филиал – NOT_FOUND (чтение и запись); незарегистрированный тип – отказ; реестр без дублей', async () => {
    const r = newRepair(BR_B);
    const a = await add(r, PNG);
    await fails(getAttachment(pool, ctx('admin', [BR_A]), a.id), 'NOT_FOUND');
    await fails(add(r, PNG, {}, ctx('director', [BR_A])), 'NOT_FOUND');
    expect((await getAttachment(pool, ctx('admin', [BR_B]), a.id)).attachment.id).toBe(a.id);
    await fails(
      tx((t) => addAttachment(t, ctx('admin', [BR_B]), store, { ownerType: 'nobody', ownerId: r, docType: 'photo', content: PNG }, meta(owner), clock)),
      'VALIDATION_FAILED',
    );
    expect(() => registerAttachmentOwner('test_repair', { canRead: async () => {}, canWrite: async () => {} })).toThrow(/уже зарегистрирован/);
    expect(() => registerAttachmentOwner('Bad-Type', { canRead: async () => {}, canWrite: async () => {} })).toThrow(/недопустимый/);
    await fails(getAttachment(pool, owner, randomUUID()), 'NOT_FOUND');
  });

  it('0302 вверх/вниз/вверх на чистой базе', async () => {
    const clean = await createTestDatabase({ migrate: true });
    try {
      const later = await clean.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.schema_migrations WHERE version >= '0302'`);
      const down = await migrateDown(clean.client, later.rows[0]!.n);
      expect(down.at(-1)).toBe('0302');
      expect((await clean.client.query(`SELECT to_regclass('app.attachments') AS t`)).rows).toEqual([{ t: null }]);
      expect(await migrateUp(clean.client)).toEqual([...down].reverse());
    } finally {
      await clean.drop();
    }
  });
});

describe('S4-06: квота по корню, обход и удаление', () => {
  let quotaRoot: string;
  const body = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
  beforeAll(async () => {
    quotaRoot = await mkdtemp(path.join(os.tmpdir(), 'yu-quota-'));
  });
  afterAll(async () => {
    await rm(quotaRoot, { recursive: true, force: true });
  });

  it('путь наружу в корне медиа → ошибка, файла снаружи нет', async () => {
    const media = createFileStore({ root: quotaRoot, quota: { maxBytes: 100, code: 'MEDIA_QUOTA_EXCEEDED' } });
    await expect(media.writeAtomic('../../etc/passwd', body(1))).rejects.toBeInstanceOf(UnsafePathError);
    await expect(media.remove('../../etc/passwd')).rejects.toBeInstanceOf(UnsafePathError);
  });

  it('запись сверх квоты → MEDIA_QUOTA_EXCEEDED 507; файла и временного остатка нет; замена считается по разнице', async () => {
    const dir = path.join(quotaRoot, 'q1');
    const media = createFileStore({ root: dir, quota: { maxBytes: 100, code: 'MEDIA_QUOTA_EXCEEDED' } });
    expect(await media.usedBytes()).toBe(0); // корня ещё нет
    await media.writeAtomic('aa/first.webp', body(60));
    expect(await media.usedBytes()).toBe(60);
    const err = await media.writeAtomic('aa/second.webp', body(41)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('MEDIA_QUOTA_EXCEEDED');
    expect((err as AppError).httpStatus).toBe(507);
    expect(await media.exists('aa/second.webp')).toBe(false);
    expect(await readdir(path.join(dir, '.tmp'))).toEqual([]);
    await media.writeAtomic('aa/second.webp', body(40)); // ровно до предела
    await media.writeAtomic('aa/first.webp', body(60, 2)); // замена того же размера – не превышение
    expect(await media.usedBytes()).toBe(100);
    await expect(media.putContent(PNG, { maxBytes: 1000, allowedTypes: [] })).rejects.toMatchObject({ code: 'MEDIA_QUOTA_EXCEEDED' });
  });

  it('обход не видит временный каталог; удаление – без ошибки при повторе; без квоты – как раньше', async () => {
    const dir = path.join(quotaRoot, 'q2');
    const media = createFileStore({ root: dir });
    await media.writeAtomic('aa/bb/one.webp', body(5));
    await media.writeAtomic('aa/two.webp', body(7));
    await expect(media.writeAtomic('aa/three.webp', body(9), { maxBytes: 8 })).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
    const seen: string[] = [];
    for await (const e of media.list()) seen.push(`${e.relative}:${e.sizeBytes}`);
    expect(seen.sort()).toEqual(['aa/bb/one.webp:5', 'aa/two.webp:7']);
    await media.remove('aa/two.webp');
    await media.remove('aa/two.webp');
    expect(await media.exists('aa/two.webp')).toBe(false);
    expect(await media.usedBytes()).toBe(5);
  });
});
