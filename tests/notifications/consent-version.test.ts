// S4-20 (K22 §7, K21 §4, K9): версия согласия на рекламу – живая версия advertising-consent, а не константа. Страница не опубликована → включить рекламу нельзя
// (MARKETING_DOCUMENT_MISSING), выключить можно; новая версия → новое согласие с новой версией, старое с прежней не трогается; версия от клиента не принимается.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditRequestMeta } from '../../apps/api/src/core/audit.ts';
import { fixedClock } from '../../apps/api/src/core/time.ts';
import { updateNotificationSettings } from '../../apps/api/src/modules/notifications/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

const clock = fixedClock('2026-11-14T05:00:00Z');
const meta: AuditRequestMeta = { actor: { kind: 'system', process: 'test' }, source: 'account', requestId: 'r' };
let db: TestDatabase;
let pool: pg.Pool;
let phone = 79140000000;

const client = async () => (await db.client.query<{ id: string }>(`INSERT INTO app.clients (phone_e164, status, created_by_type) VALUES ($1, 'active', 'system') RETURNING id`, [`+${phone++}`])).rows[0]!.id;
const put = (id: string, marketingEnabled: boolean, documentVersion?: string) =>
  updateNotificationSettings(pool, clock, id, { remindersEnabled: true, marketingEnabled, ...(documentVersion ? { documentVersion } : {}) }, randomUUID(), meta);
const consents = async (id: string) =>
  (await db.client.query<{ granted: boolean; document_version: string | null }>(`SELECT granted, document_version FROM journal.client_consents WHERE client_id = $1 AND kind = 'marketing' ORDER BY id`, [id])).rows;
const prefs = async (id: string) => (await db.client.query<{ marketing_enabled: boolean }>(`SELECT marketing_enabled FROM app.client_notification_prefs WHERE client_id = $1`, [id])).rows[0]?.marketing_enabled;
const publish = (version: string) =>
  db.client.query(
    `INSERT INTO app.content_pages (key, document_version, status, draft, draft_updated_at, draft_updated_by, created_by, created_at)
     VALUES ('advertising-consent', $1, 'published', '{}', now(), gen_random_uuid(), gen_random_uuid(), now())
     ON CONFLICT (key, city_id) DO UPDATE SET document_version = EXCLUDED.document_version, status = 'published'`,
    [version],
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('версия согласия на рекламу', () => {
  it('страница не опубликована: включить нельзя, ничего не записано; напоминания менять можно', async () => {
    const id = await client();
    await expect(put(id, true)).rejects.toMatchObject({ code: 'MARKETING_DOCUMENT_MISSING', httpStatus: 409 });
    expect(await consents(id)).toEqual([]);
    expect(await prefs(id)).toBeUndefined();
    await expect(updateNotificationSettings(pool, clock, id, { remindersEnabled: false, marketingEnabled: false }, randomUUID(), meta)).resolves.toMatchObject({ status: 200 });
  });

  it('опубликована: согласие с живой версией; присланная клиентом версия не принимается', async () => {
    await publish('advertising-consent-2026-11-01');
    const id = await client();
    await put(id, true, 'marketing-поддельная');
    expect(await consents(id)).toEqual([{ granted: true, document_version: 'advertising-consent-2026-11-01' }]);
  });

  it('новая версия: новое согласие с новой, старое с прежней остаётся; выключить можно и без страницы', async () => {
    const id = await client();
    await publish('advertising-consent-2026-11-01');
    await put(id, true);
    await publish('advertising-consent-2026-12-01');
    await put(id, false);
    const other = await client();
    await put(other, true);
    expect(await consents(id)).toEqual([
      { granted: true, document_version: 'advertising-consent-2026-11-01' },
      { granted: false, document_version: null },
    ]);
    expect(await consents(other)).toEqual([{ granted: true, document_version: 'advertising-consent-2026-12-01' }]);
    await put(id, true);
    expect((await consents(id)).at(-1)).toEqual({ granted: true, document_version: 'advertising-consent-2026-12-01' });
    await db.client.query(`UPDATE app.content_pages SET status = 'unpublished' WHERE key = 'advertising-consent'`);
    await put(id, false);
    expect(await prefs(id)).toBe(false);
    await expect(put(id, true)).rejects.toMatchObject({ code: 'MARKETING_DOCUMENT_MISSING' });
  });

  it('уже включённая реклама при смене только напоминаний новых согласий не требует', async () => {
    await publish('advertising-consent-2026-12-01');
    const id = await client();
    await put(id, true);
    await db.client.query(`UPDATE app.content_pages SET status = 'unpublished' WHERE key = 'advertising-consent'`);
    await expect(updateNotificationSettings(pool, clock, id, { remindersEnabled: false, marketingEnabled: true }, randomUUID(), meta)).resolves.toMatchObject({ status: 200 });
    expect(await consents(id)).toHaveLength(1);
  });
});
