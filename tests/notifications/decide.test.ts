// S4-12: миграция 0402 и decideSend (K21 §2) на настоящей Postgres.
// Табличный тест: 3 категории × настройки × журнал согласий × источник (система / сотрудник) – решение от категории, не от источника.
// Неизменность подтверждённой кампании от роли yu_app → 42501; вверх / вниз / вверх.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../db/migrate.ts';
import { decideSend, type Category, type SendDecision } from '../../apps/api/src/modules/notifications/index.ts';
import { createTestBranch } from '../helpers/network.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/pg.ts';

let db: TestDatabase;
let pool: pg.Pool;
let branchId: string;
let staffId: string;
let phone = 79150001000;
const now = new Date('2026-11-20T06:00:00Z');

type Consent = 'none' | 'granted' | 'revoked';

async function client(o: { reminders?: boolean; marketing?: boolean; consent?: Consent; status?: string; sub?: boolean } = {}): Promise<string> {
  const id = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.clients (phone_e164, status, registered_at, created_by_type) VALUES ($1, $2, now(), 'system') RETURNING id`,
      [`+${++phone}`, o.status ?? 'active'],
    )
  ).rows[0]!.id;
  await db.client.query('INSERT INTO app.client_notification_prefs (client_id, reminders_enabled, marketing_enabled) VALUES ($1, $2, $3)', [
    id,
    o.reminders ?? true,
    o.marketing ?? false,
  ]);
  const consent = o.consent ?? 'none';
  if (consent !== 'none') {
    await db.client.query(
      `INSERT INTO journal.client_consents (client_id, kind, granted, document_version, source, at, actor_type, actor_id) VALUES ($1, 'marketing', true, 'v1', 'account', $2, 'client', $1)`,
      [id, new Date(now.getTime() - 7200_000)],
    );
    if (consent === 'revoked') {
      await db.client.query(
        `INSERT INTO journal.client_consents (client_id, kind, granted, source, at, actor_type, actor_id) VALUES ($1, 'marketing', false, 'account', $2, 'client', $1)`,
        [id, new Date(now.getTime() - 3600_000)],
      );
    }
  }
  if (o.sub ?? true) {
    await db.client.query(`INSERT INTO app.push_subscriptions (client_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)`, [
      id,
      `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      'B'.repeat(87),
      'A'.repeat(22),
    ]);
  }
  return id;
}

async function marketingRow(clientId: string, status: string, at: Date): Promise<void> {
  await db.client.query(
    `INSERT INTO app.notifications (client_id, branch_id, category, kind, source, title, body, planned_at, status, sent_at, updated_at, dedupe_key)
     VALUES ($1, $2, 'marketing', 'campaign', 'staff', 'Реклама. Акция', 'Текст', $3, $4, $5, $3, $6)`,
    [clientId, branchId, at, status, status === 'sent_to_provider' ? at : null, `t:${randomUUID()}`],
  );
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  pool = new pg.Pool({ connectionString: db.url, options: '-c role=yu_app -c search_path=app,journal', max: 4 });
  branchId = (await createTestBranch(db.client)).id;
  staffId = (
    await db.client.query<{ id: string }>(
      `INSERT INTO app.staff (first_name, last_name, email, role, password_hash) VALUES ('Ольга', 'Владелец', $1, 'owner', 'x') RETURNING id`,
      [`o-${randomUUID()}@yu.test`],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('decideSend K21 §2 – табличный тест', () => {
  const cases: Array<{ category: Category; reminders: boolean; marketing: boolean; consent: Consent; expect: SendDecision }> = [];
  for (const reminders of [true, false]) {
    for (const marketing of [true, false]) {
      for (const consent of ['none', 'granted', 'revoked'] as const) {
        cases.push({ category: 'service', reminders, marketing, consent, expect: { ok: true } });
        cases.push({ category: 'reminder', reminders, marketing, consent, expect: reminders ? { ok: true } : { ok: false, status: 'skipped_by_prefs', reason: 'reminders_off' } });
        cases.push({
          category: 'marketing',
          reminders,
          marketing,
          consent,
          expect: !marketing
            ? { ok: false, status: 'skipped_by_prefs', reason: 'marketing_off' }
            : consent === 'granted'
              ? { ok: true }
              : { ok: false, status: 'skipped_by_prefs', reason: 'no_marketing_consent' },
        });
      }
    }
  }

  it(`${cases.length} сочетаний × источник system/staff: решение одно и то же, от категории`, async () => {
    for (const c of cases) {
      const id = await client({ reminders: c.reminders, marketing: c.marketing, consent: c.consent });
      // источник (система или сотрудник) во вход решения не входит вовсе – одно и то же для обоих
      for (const source of ['system', 'staff']) {
        const d = await decideSend(pool, { clientId: id, category: c.category, push: true }, now);
        expect({ ...c, source, got: d }).toEqual({ ...c, source, got: c.expect });
      }
    }
  });

  it('заблокированный, удаляемый, обезличенный: реклама – client_inactive, сервисное – уходит', async () => {
    for (const status of ['blocked', 'deletion_requested', 'anonymized']) {
      const id = await client({ marketing: true, consent: 'granted', status });
      expect(await decideSend(pool, { clientId: id, category: 'marketing', push: true }, now)).toEqual({ ok: false, status: 'skipped_by_prefs', reason: 'client_inactive' });
      expect(await decideSend(pool, { clientId: id, category: 'service', push: true }, now)).toEqual({ ok: true });
    }
  });

  it('без подписки – no_channel (строка остаётся в центре); push=false – подписка не нужна', async () => {
    const id = await client({ sub: false });
    expect(await decideSend(pool, { clientId: id, category: 'service', push: true }, now)).toEqual({ ok: false, status: 'no_channel' });
    expect(await decideSend(pool, { clientId: id, category: 'service', push: false }, now)).toEqual({ ok: true });
  });

  it('частота: реклама 2 дня назад (sent_to_provider) или взятая отправителем (sending) → skipped_by_frequency; 8 дней назад – нет', async () => {
    const a = await client({ marketing: true, consent: 'granted' });
    await marketingRow(a, 'sent_to_provider', new Date(now.getTime() - 2 * 86_400_000));
    expect(await decideSend(pool, { clientId: a, category: 'marketing', push: true }, now)).toEqual({ ok: false, status: 'skipped_by_frequency', reason: 'min_interval' });
    const b = await client({ marketing: true, consent: 'granted' });
    await marketingRow(b, 'sending', new Date(now.getTime() - 60_000));
    expect((await decideSend(pool, { clientId: b, category: 'marketing', push: true }, now)).ok).toBe(false);
    const c = await client({ marketing: true, consent: 'granted' });
    await marketingRow(c, 'sent_to_provider', new Date(now.getTime() - 8 * 86_400_000));
    await marketingRow(c, 'skipped_by_prefs', new Date(now.getTime() - 60_000));
    expect(await decideSend(pool, { clientId: c, category: 'marketing', push: true }, now)).toEqual({ ok: true });
    // сервисное частотой не ограничено
    expect(await decideSend(pool, { clientId: a, category: 'service', push: true }, now)).toEqual({ ok: true });
  });
});

describe('миграция 0402', () => {
  it('UPDATE title подтверждённой кампании от yu_app → 42501; черновик правится; статус и счётчики подтверждённой – меняются', async () => {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO app.notification_campaigns (category, title, body, audience, area_type, area_ids, created_by)
       VALUES ('marketing', 'Реклама. Скидка', 'Текст', '{"kind":"segment"}', 'branch', ARRAY[$1::uuid], $2) RETURNING id`,
      [branchId, staffId],
    );
    const id = ins.rows[0]!.id;
    await pool.query(`UPDATE app.notification_campaigns SET title = 'Реклама. Скидка 20%' WHERE id = $1`, [id]);
    await pool.query(`UPDATE app.notification_campaigns SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, total = 3 WHERE id = $1`, [id, staffId]);
    for (const set of [`title = 'другое'`, `body = 'другое'`, `url = '/x/'`, `category = 'service'`, `audience = '{}'`, `push = false`]) {
      await expect(pool.query(`UPDATE app.notification_campaigns SET ${set} WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    }
    await pool.query(`UPDATE app.notification_campaigns SET status = 'sending', row_version = row_version + 1 WHERE id = $1`, [id]);
    // снимок получателей – только вставка
    const c = await client();
    await pool.query(`INSERT INTO journal.notification_campaign_recipients (campaign_id, client_id, home_branch_id, decision) VALUES ($1, $2, $3, 'ok')`, [id, c, branchId]);
    await expect(pool.query(`UPDATE journal.notification_campaign_recipients SET decision = 'x'`)).rejects.toMatchObject({ code: '42501' });
  });

  it('вверх / вниз / вверх', async () => {
    const t = await createTestDatabase({ migrate: true });
    try {
      const later = (await t.client.query<{ version: string }>(`SELECT version FROM public.schema_migrations WHERE version >= '0402' ORDER BY version`)).rows.map((r) => r.version);
      expect((await migrateDown(t.client, later.length)).at(-1)).toBe('0402');
      expect((await t.client.query(`SELECT to_regclass('app.notification_campaigns') AS r`)).rows[0].r).toBeNull();
      expect(await migrateUp(t.client)).toEqual(later);
      expect((await t.client.query(`SELECT * FROM journal.append_only_violations()`)).rows).toEqual([]);
    } finally {
      await t.drop();
    }
  });
});
