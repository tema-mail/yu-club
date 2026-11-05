// Общая обвязка тестов CMS: база с миграциями, пул yu_app, медиатека во временном каталоге, контекст сотрудника, транзакция.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { expect } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { AppError } from '../../apps/api/src/core/errors.ts';
import { createFileStore, type FileStore } from '../../apps/api/src/core/files.ts';
import type { AccessContext, StaffRole } from '../../apps/api/src/core/permissions.ts';
import { fixedClock, type Clock } from '../../apps/api/src/core/time.ts';
import { uploadMedia } from '../../apps/api/src/modules/content/media.ts';
import { createTestDatabase, type TestDatabase } from './pg.ts';

export const NOW = new Date('2026-11-14T05:00:00Z');
export const clock: Clock = fixedClock('2026-11-14T05:00:00Z');

export interface ContentFixture {
  db: TestDatabase;
  pool: pg.Pool;
  root: string;
  store: FileStore;
  staffId: string;
  ctx(role: StaffRole, branchIds?: string[], cityIds?: string[]): AccessContext;
  owner(): AccessContext;
  meta(c: AccessContext): AuditRequestMeta;
  inTx<T>(run: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Картинка в медиатеке с заданным alt. */
  image(seed: number, alt?: string | null): Promise<string>;
  close(): Promise<void>;
}

export async function contentFixture(): Promise<ContentFixture> {
  const db = await createTestDatabase({ migrate: true });
  const pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'yu-content-'));
  const store = createFileStore({ root });
  const r = await db.client.query<{ id: string }>(`INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('И', 'Ф', 'content@yu.test', 'owner', 'x') RETURNING id`);
  const staffId = r.rows[0]!.id;
  const ctx = (role: StaffRole, branchIds: string[] = [], cityIds: string[] = []): AccessContext => ({
    actor: { kind: 'staff', staffId, sessionId: randomUUID() },
    role,
    network: role === 'owner',
    cityIds: new Set(cityIds),
    branchIds: new Set(branchIds),
    at: NOW,
  });
  const meta = (c: AccessContext): AuditRequestMeta => ({ actor: c.actor, access: c, source: 'crm', requestId: randomUUID() });
  const owner = () => ctx('owner');
  return {
    db,
    pool,
    root,
    store,
    staffId,
    ctx,
    owner,
    meta,
    async inTx<T>(run: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const v = await run(client);
        await client.query('COMMIT');
        return v;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async image(seed, alt = 'Описание') {
      const content = await sharp({ create: { width: 100 + seed, height: 60, channels: 3, background: { r: seed % 256, g: 80, b: 120 } } }).png().toBuffer();
      const c = owner();
      return (await uploadMedia(pool, c, store, { content, purpose: 'image', alt }, meta(c), clock)).media.id;
    },
    async close() {
      await pool.end();
      await db.drop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function fails(p: Promise<unknown>, code: string): Promise<AppError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}
