// K21 §6: разворачивание подтверждённой кампании в строки notifications и её закрытие.
// Пачками по 500 из снимка получателей; dedupe_key = 'campaign:<campaignId>:<clientId>' + ON CONFLICT DO NOTHING – повтор и параллельная
// задача не дублируют. Каждая пачка – своя транзакция под FOR UPDATE кампании: отмена (тоже FOR UPDATE) встаёт между пачками,
// после неё новых строк нет. decideSend повторяется при создании строки: отказ после подтверждения новых строк не создаёт (K21 §4).
// Плановый момент рекламы – начало окна тихих часов по зоне домашнего филиала (K21 §4, K8), не зависит от TZ процесса.
// Подстановка плейсхолдеров – только здесь; имя клиента попадает в строку клиента, но не в аудит (K21 §15).
// Запуск – таймером процесса worker, как остальные периодические задачи (startCampaignRunner); параллельные worker безопасны.
import type { Db, Tx } from '../../core/audit.ts';
import { resolveSettings } from '../../core/settings.ts';
import { addDays, instantToLocal, localToInstant, parseLocalTime, systemClock, type Clock, type LocalDate, type TimeZone } from '../../core/time.ts';
import { withTx, type Pool } from '../clients/index.ts';
import type { Audience, CampaignCategory, CampaignStatus } from './campaigns.ts';
import { RECIPIENT_PASSES } from './campaigns.ts';
import { decideSend } from './index.ts';
import { renderText, type PlaceholderValues } from './templates.ts';

export const EXPAND_BATCH = 500;

export interface MarketingWindow {
  from: string;
  to: string;
}

export async function marketingWindow(db: Db, at: Date): Promise<MarketingWindow> {
  const s = await resolveSettings(db, ['notifications.marketing_window_from', 'notifications.marketing_window_to'], { network: true }, at);
  return { from: s['notifications.marketing_window_from'].value, to: s['notifications.marketing_window_to'].value };
}

const DEFAULT_MARKETING_WINDOW: MarketingWindow = { from: '10:00', to: '21:00' }; // K21 §13

/** Момент не раньше at внутри окна [from, to) по зоне tz: в окне – сам at, до окна – его начало сегодня, после – начало завтра. */
export function windowStart(at: Date, tz: TimeZone, w: MarketingWindow): Date {
  // from < to держит сохранение настройки (core/settings); неверная строка в базе не должна открывать рекламу ночью
  const { from, to } = w.from < w.to ? w : DEFAULT_MARKETING_WINDOW;
  const local = instantToLocal(at, tz);
  if (local.time >= from && local.time < to) return at;
  const day: LocalDate = local.time < from ? local.date : addDays(local.date, 1);
  return localToInstant(day, parseLocalTime(from), tz);
}

/** Заголовок рекламы с пометкой (K21 §4). Уже начинается с неё – без повтора. Обрезка – по CHECK 0111. */
export function withMarketingPrefix(title: string, prefix: string): string {
  const t = prefix && !title.startsWith(prefix) ? `${prefix} ${title}` : title;
  return t.slice(0, 120);
}

interface CampaignRow {
  id: string;
  status: CampaignStatus;
  category: CampaignCategory;
  title: string;
  body: string;
  url: string | null;
  push: boolean;
  audience: Audience;
  purpose: string | null;
  planned_at: Date | null;
  created_by: string;
}

interface RecipientRow {
  id: string;
  client_id: string;
  home_branch_id: string | null;
  decision: string;
  first_name: string | null;
  branch_name: string | null;
  branch_address: string | null;
  branch_timezone: TimeZone | null;
  city_name: string | null;
}

async function expandBatch(
  tx: Tx,
  c: CampaignRow,
  batch: RecipientRow[],
  settings: { window: MarketingWindow; prefix: string },
  now: Date,
): Promise<void> {
  const base = c.planned_at && c.planned_at.getTime() > now.getTime() ? c.planned_at : now;
  for (const r of batch) {
    // при создании строки решение повторяется, частота и канал здесь не важны – их проверит send (push: false)
    const d = await decideSend(tx, { clientId: r.client_id, category: c.category, push: false }, now);
    if (!d.ok && d.status === 'skipped_by_prefs') continue;
    if (!d.ok && !c.push) continue; // только центр: send эту строку не перепроверит
    const values: PlaceholderValues = { 'client.firstName': r.first_name, 'branch.name': r.branch_name, 'branch.address': r.branch_address, 'city.name': r.city_name };
    const title = renderText(c.title, values);
    const plannedAt = c.category === 'marketing' && r.branch_timezone ? windowStart(base, r.branch_timezone, settings.window) : base;
    await tx.query(
      `INSERT INTO app.notifications (client_id, branch_id, category, kind, booking_id, booking_version, source, initiator_id, title, body, url,
         planned_at, status, push, campaign_id, purpose, dedupe_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        r.client_id,
        r.home_branch_id,
        c.category,
        c.audience.kind === 'segment' ? 'campaign' : 'personal',
        c.audience.kind === 'segment' ? null : (c.audience.bookingId ?? null),
        null, // версия брони личному не нужна: send проверяет только отмену и клиента (K21 §7 п.2)
        c.created_by,
        c.category === 'marketing' ? withMarketingPrefix(title, settings.prefix) : title.slice(0, 120),
        renderText(c.body, values).slice(0, 500),
        c.url,
        plannedAt,
        c.push ? 'planned' : 'inbox_only',
        c.push,
        c.id,
        c.purpose,
        `campaign:${c.id}:${r.client_id}`,
        now,
      ],
    );
  }
}

/** Разворачивание одной кампании до конца. Возвращает число просмотренных получателей. Другой статус (отменена, готова) – 0. */
export async function expandCampaign(pool: Pool, clock: Clock, id: string, batchSize = EXPAND_BATCH): Promise<number> {
  let cursor = '0';
  let seen = 0;
  for (;;) {
    const done = await withTx(pool, async (tx) => {
      const now = clock.now();
      const c = (
        await tx.query<CampaignRow>(
          `SELECT id, status, category, title, body, url, push, audience, purpose, planned_at, created_by FROM app.notification_campaigns WHERE id = $1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!c || (c.status !== 'confirmed' && c.status !== 'expanding')) return true;
      // строки клиентов FOR KEY SHARE: обезличивание (FOR UPDATE) либо ждёт конца пачки и затирает уже вставленное имя
      // (anonymizeClientNotifications), либо идёт первым – тогда пачка ждёт его и по перечитанной строке клиента пропускает (D4-63)
      const r = await tx.query<RecipientRow>(
        `SELECT r.id, r.client_id, r.home_branch_id, r.decision, cl.first_name, b.name AS branch_name, b.address AS branch_address, b.timezone AS branch_timezone, ci.name AS city_name
         FROM journal.notification_campaign_recipients r
         JOIN app.clients cl ON cl.id = r.client_id
         LEFT JOIN app.branches b ON b.id = r.home_branch_id
         LEFT JOIN app.cities ci ON ci.id = b.city_id
         WHERE r.campaign_id = $1 AND r.id > $2::bigint AND cl.status <> 'anonymized' ORDER BY r.id LIMIT $3
         FOR KEY SHARE OF cl`,
        [id, cursor, batchSize],
      );
      if (r.rows.length === 0) {
        await tx.query(`UPDATE app.notification_campaigns SET status = 'sending', updated_at = $2 WHERE id = $1`, [id, now]);
        return true;
      }
      if (c.status === 'confirmed') await tx.query(`UPDATE app.notification_campaigns SET status = 'expanding', updated_at = $2 WHERE id = $1`, [id, now]);
      const s = await resolveSettings(tx, ['notifications.marketing_title_prefix'], { network: true }, now);
      await expandBatch(
        tx,
        c,
        r.rows.filter((x) => RECIPIENT_PASSES.has(x.decision)),
        { window: await marketingWindow(tx, now), prefix: s['notifications.marketing_title_prefix'].value },
        now,
      );
      cursor = r.rows.at(-1)!.id;
      seen += r.rows.length;
      return false;
    });
    if (done) return seen;
  }
}

/** Закрытие (K21 §6, notifications:campaign-close): sending без строк planned/queued/sending → done. */
export async function closeCampaigns(pool: Pool, clock: Clock): Promise<number> {
  const now = clock.now();
  const r = await pool.query(
    `UPDATE app.notification_campaigns c SET status = 'done', updated_at = $1 WHERE c.status = 'sending'
       AND NOT EXISTS (SELECT 1 FROM app.notifications n WHERE n.campaign_id = c.id AND n.status IN ('planned','queued','sending'))`,
    [now],
  );
  return r.rowCount ?? 0;
}

/** Один проход: развернуть всё подтверждённое, закрыть завершённое. */
export async function runCampaignTick(pool: Pool, clock: Clock): Promise<{ expanded: number; closed: number }> {
  const ids = await pool.query<{ id: string }>(`SELECT id FROM app.notification_campaigns WHERE status IN ('confirmed','expanding') ORDER BY confirmed_at, id`);
  for (const { id } of ids.rows) await expandCampaign(pool, clock, id);
  return { expanded: ids.rows.length, closed: await closeCampaigns(pool, clock) };
}

/** Таймер worker. Итерации не накладываются. Возвращает остановку. */
export function startCampaignRunner(deps: { pool: Pool; clock?: Clock }, opts: { intervalMs?: number; log?: (err: unknown) => void } = {}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runCampaignTick(deps.pool, deps.clock ?? systemClock);
    } catch (err) {
      (opts.log ?? ((e) => console.error('notifications: кампании', e)))(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Обезличивание клиента (K9, K21 §15): в строках его кампаний title/body пересобираются из текста кампании без имени.
 * Строки брони имени не содержат (K14 draftText). В аудит подстановка не пишется по построению: campaign_confirmed – шаблон,
 * notification.sent/failed/skipped/retried – без текста. Вызывает процедура обезличивания в той же транзакции.
 */
export async function anonymizeClientNotifications(tx: Tx, clientId: string, now: Date): Promise<number> {
  const rows = await tx.query<{ id: string; title: string; body: string; category: CampaignCategory; branch_name: string | null; branch_address: string | null; city_name: string | null }>(
    `SELECT n.id, c.title, c.body, c.category, b.name AS branch_name, b.address AS branch_address, ci.name AS city_name
     FROM app.notifications n JOIN app.notification_campaigns c ON c.id = n.campaign_id
     LEFT JOIN app.branches b ON b.id = n.branch_id LEFT JOIN app.cities ci ON ci.id = b.city_id
     WHERE n.client_id = $1`,
    [clientId],
  );
  if (rows.rows.length === 0) return 0;
  const prefix = (await resolveSettings(tx, ['notifications.marketing_title_prefix'], { network: true }, now))['notifications.marketing_title_prefix'].value;
  for (const r of rows.rows) {
    const values: PlaceholderValues = { 'client.firstName': null, 'branch.name': r.branch_name, 'branch.address': r.branch_address, 'city.name': r.city_name };
    const title = renderText(r.title, values) || 'Сообщение';
    await tx.query('UPDATE app.notifications SET title = $2, body = $3, updated_at = $4 WHERE id = $1', [
      r.id,
      r.category === 'marketing' ? withMarketingPrefix(title, prefix) : title.slice(0, 120),
      (renderText(r.body, values) || 'Сообщение').slice(0, 500),
      now,
    ]);
  }
  return rows.rows.length;
}
