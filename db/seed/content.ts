// S4-130. Тестовые данные Э4 поверх засевов Э0 и Э1 (db/seed/dev.ts, db/seed/resources.ts): медиа (маленькие картинки, нарисованные sharp
// на месте, без внешних загрузок), публикации трёх типов (новость, акция, розыгрыш) с охватом сеть / город / филиал, игры трёх направлений
// с доступностью по филиалам, страницы «О клубе», «Правила» и вступление к контактам города, две кампании уведомлений – черновиками.
// Всё – командами модулей content и notifications: с проверками полноты, версиями и аудитом. Юридические документы не засеваются:
// демо-текст политики на стенде дал бы галочку согласия со ссылкой на выдуманный документ.
// Кампании не подтверждаются: подтверждённая разошлась бы push реальным подписчикам стенда; предпросмотр и подтверждение – кнопкой в CRM.
// Повтор без дублей: медиа ищется по title (демо-метка), публикации и игры – по слагу с префиксом demo-, страница – ensurePage по ключу,
// кампания – по advertiser_note. Опубликованное повторно не публикуется (версий не прибавляется).
// На прод не попадает: assertNotProduction до первого запроса к базе (19 §10.1).
//
// CLI – через db/seed/dev.ts (нужен MEDIA_DIR); отдельно: APP_ENV=stage DATABASE_URL=... MEDIA_DIR=/data/media node db/seed/content.ts
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { createFileStore } from '../../apps/api/src/core/files.ts';
import { addDays, localToInstant, systemClock, todayIn, type Clock, type LocalTime, type TimeZone } from '../../apps/api/src/core/time.ts';
import { bookingLookup } from '../../apps/api/src/modules/booking/providers.ts';
import { gameDef, setGameBranch, type GameDirection, type GameDraft } from '../../apps/api/src/modules/content/games.ts';
import { uploadMedia } from '../../apps/api/src/modules/content/media.ts';
import { ensurePage, pageDef } from '../../apps/api/src/modules/content/pages.ts';
import { publicationDef, type PublicationDraft, type PublicationType, type Scope } from '../../apps/api/src/modules/content/publications.ts';
import { createEntity, publish, saveDraft, type EntityDef, type EntityRow } from '../../apps/api/src/modules/content/versions.ts';
import { systemGiftContext } from '../../apps/api/src/modules/events/gift-resource.ts';
import { branchIdsOfCities, timezonesOf } from '../../apps/api/src/modules/network/index.ts';
import { createCampaign, type CampaignInput } from '../../apps/api/src/modules/notifications/campaigns.ts';
import { withTx, type Pool } from '../../apps/api/src/modules/staff/auth.ts';
import { assertNotProduction, DEMO_MARK } from './dev.ts';
import { DEMO_CLIENTS } from './resources.ts';

const LOCK_KEY = 7_204_513_064;
const mark = (n: string): string => `${DEMO_MARK} #${n}`;

const MEDIA = [
  { key: 'news', color: '#1f4e79', alt: 'Зал с компьютерами клуба (демо)' },
  { key: 'promo', color: '#7a1f4e', alt: 'Афиша акции (демо)' },
  { key: 'giveaway', color: '#2e7a1f', alt: 'Приз розыгрыша (демо)' },
  { key: 'game', color: '#4e1f7a', alt: 'Обложка игры (демо)' },
] as const;
type MediaKey = (typeof MEDIA)[number]['key'];

const TYPES: Array<{ type: Exclude<PublicationType, 'tournament'>; media: MediaKey; name: string }> = [
  { type: 'news', media: 'news', name: 'Новость' },
  { type: 'promotion', media: 'promo', name: 'Акция' },
  { type: 'giveaway', media: 'giveaway', name: 'Розыгрыш' },
];
const SCOPES = ['network', 'city', 'branch'] as const;
const SCOPE_NAME = { network: 'вся сеть', city: 'Новосибирск', branch: 'Арбат' } as const;

/** Игры и доступность по филиалам: ключ – код филиала, нет ключа – строки нет (игра в филиале недоступна, 12 §6.1). */
const GAMES: Array<{ direction: GameDirection; slug: string; title: string; platforms?: string[]; full: boolean; branches: Record<string, boolean> }> = [
  { direction: 'pc', slug: 'demo-counter-strike-2', title: 'Counter-Strike 2 (демо)', full: true, branches: { 'demo-nsk-krasny': true, 'demo-msk-arbat': false } },
  { direction: 'vr', slug: 'demo-beat-saber', title: 'Beat Saber (демо)', full: true, branches: { 'demo-nsk-krasny': true, 'demo-msk-arbat': true } },
  { direction: 'playstation', slug: 'demo-ea-fc', title: 'EA Sports FC (демо)', platforms: ['PS5'], full: false, branches: { 'demo-msk-arbat': true } },
];

const PAGES: Array<{ key: 'about' | 'rules' | 'contacts_intro'; city: string | null; title: string; body: string }> = [
  { key: 'about', city: null, title: 'О клубе (демо)', body: 'Сеть компьютерных клубов «Ю». Демо-текст стенда, не для прода.' },
  { key: 'rules', city: null, title: 'Правила клуба (демо)', body: '1. Приходите за 10 минут до начала.\n2. Бережно обращайтесь с техникой.\n\nДемо-текст стенда.' },
  { key: 'contacts_intro', city: 'demo-nsk', title: 'Контакты в Новосибирске (демо)', body: 'Звоните или приходите – ждём. Демо-текст стенда.' },
];

export interface ContentSeedReport {
  created: { media: number; publications: number; games: number; availability: number; pages: number; campaigns: number };
  mediaIds: Record<string, string>;
  publicationIds: Record<string, string>;
  gameIds: Record<string, string>;
  campaignIds: string[];
}

export async function seedContent(pool: pg.Pool, opts: { env: { APP_ENV?: string | undefined; NODE_ENV?: string | undefined }; mediaDir: string }, clock: Clock = systemClock): Promise<ContentSeedReport> {
  assertNotProduction(opts.env);
  const lockConn = await pool.connect();
  try {
    await lockConn.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]); // два параллельных засева не создадут дублей
    return await run(pool, opts.mediaDir, clock);
  } finally {
    await lockConn.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockConn.release();
  }
}

async function run(pool: pg.Pool, mediaDir: string, clock: Clock): Promise<ContentSeedReport> {
  const db: Pool = pool;
  const branches = new Map((await pool.query<{ id: string; code: string; timezone: TimeZone }>(`SELECT id, code, timezone FROM app.branches WHERE code LIKE 'demo-%'`)).rows.map((b) => [b.code, b]));
  const cities = new Map((await pool.query<{ id: string; code: string }>(`SELECT id, code FROM app.cities WHERE code LIKE 'demo-%'`)).rows.map((c) => [c.code, c.id]));
  const owner = (await pool.query<{ id: string }>(`SELECT id FROM app.staff WHERE role = 'owner' AND status = 'active'`)).rows[0];
  const client = (await pool.query<{ id: string }>(`SELECT id FROM app.clients WHERE phone_e164 = $1`, [DEMO_CLIENTS[0].phone])).rows[0];
  const krasny = branches.get('demo-nsk-krasny');
  const arbat = branches.get('demo-msk-arbat');
  const nsk = cities.get('demo-nsk');
  if (!owner || !krasny || !arbat || !nsk || !client) throw new Error('Нет демо-филиалов, Владельца или клиентов: сначала засев Э0 и Э1 (db/seed/dev.ts)');
  const { ctx, meta } = systemGiftContext(owner.id, clock.now());
  const created: ContentSeedReport['created'] = { media: 0, publications: 0, games: 0, availability: 0, pages: 0, campaigns: 0 };
  const report: ContentSeedReport = { created, mediaIds: {}, publicationIds: {}, gameIds: {}, campaignIds: [] };

  // медиа: картинка 640×360 одним цветом – рисуется здесь, сеть не нужна; повтор находит её по title
  const store = createFileStore({ root: mediaDir });
  for (const m of MEDIA) {
    const title = mark(`media-${m.key}`);
    const found = await pool.query<{ id: string }>(`SELECT id FROM app.content_media WHERE title = $1 AND status = 'active'`, [title]);
    if (found.rows[0]) {
      report.mediaIds[m.key] = found.rows[0].id;
      continue;
    }
    const content = await sharp({ create: { width: 640, height: 360, channels: 3, background: m.color } }).png().toBuffer();
    const r = await withTx(db, (tx) => uploadMedia(tx, ctx, store, { content, purpose: 'image', originalName: `demo-${m.key}.png`, alt: m.alt, title }, meta, clock));
    report.mediaIds[m.key] = r.media.id;
    if (!r.duplicate) created.media++;
  }

  /** Черновик, если его нет, и публикация, если он ещё не на сайте. Возвращает id и признак «создан сейчас». */
  const ensureLive = async <D extends Record<string, unknown>>(def: EntityDef<D>, where: string, params: unknown[], columns: Record<string, unknown>, draft: D): Promise<[string, boolean]> => {
    let row = (await pool.query<EntityRow>(`SELECT * FROM ${def.table} WHERE ${where}`, params)).rows[0];
    const fresh = !row;
    row ??= await withTx(db, (tx) => createEntity(tx, ctx, def, columns, draft, meta, clock));
    if (row.status === 'draft') {
      const r = row;
      await withTx(db, (tx) => publish(tx, ctx, def, r.id, { rowVersion: r.row_version }, meta, clock));
    }
    return [row.id, fresh];
  };

  // публикации: 3 типа × 3 охвата; показ – со вчерашнего дня, у акции – на месяц вперёд
  const today = todayIn(clock, krasny.timezone);
  const at = (days: number, time: string): string => localToInstant(addDays(today, days), time as LocalTime, krasny.timezone).toISOString();
  const scopeOf = (s: (typeof SCOPES)[number]): Scope => (s === 'network' ? { type: 'network' } : s === 'city' ? { type: 'city', cityIds: [nsk] } : { type: 'branch', branchIds: [arbat.id] });
  for (const t of TYPES) {
    const media = MEDIA.find((m) => m.key === t.media)!;
    for (const s of SCOPES) {
      const slug = `demo-${t.type}-${s}`;
      const draft: PublicationDraft = {
        scope: scopeOf(s),
        title: `${t.name}: ${SCOPE_NAME[s]} (демо)`,
        lead: `Демо-материал стенда, охват – ${SCOPE_NAME[s]}.`,
        body: `Текст демо-публикации.\n\n![${media.alt}](media:${report.mediaIds[t.media]})\n\n${DEMO_MARK}`,
        slug,
        coverMediaId: report.mediaIds[t.media]!,
        publishFrom: at(-1, '10:00'),
        ...(t.type === 'promotion' ? { publishTo: at(30, '22:00'), conditions: 'Скидка 20% на ночной пакет по будням (демо).' } : {}),
        ...(t.type === 'giveaway' ? { resultsDate: at(14, '18:00'), prize: '10 часов игры (демо)', rulesBody: 'Участвуют клиенты с бронью за период розыгрыша (демо).' } : {}),
      };
      const [id, fresh] = await ensureLive(publicationDef, `type = $1 AND draft->>'slug' = $2`, [t.type, slug], { type: t.type }, draft);
      report.publicationIds[slug] = id;
      if (fresh) created.publications++;
    }
  }

  // игры и доступность: setGameBranch пишет аудит на каждый вызов – только отсутствующие строки
  for (const g of GAMES) {
    const draft: GameDraft = {
      title: g.title,
      short: `Демо-карточка игры для стенда (${g.direction}).`,
      coverMediaId: report.mediaIds.game!,
      ...(g.full ? { full: `Подробное описание игры (демо).\n\n${DEMO_MARK}`, slug: g.slug } : {}),
      ...(g.platforms ? { platforms: g.platforms } : {}),
      genres: ['демо'],
      ageRating: '12+',
    };
    const [id, fresh] = await ensureLive(gameDef, `direction = $1 AND draft->>'title' = $2`, [g.direction, g.title], { direction: g.direction }, draft);
    report.gameIds[g.slug] = id;
    if (fresh) created.games++;
    for (const [code, available] of Object.entries(g.branches)) {
      const branchId = branches.get(code)!.id;
      if ((await pool.query(`SELECT 1 FROM app.content_game_branches WHERE game_id = $1 AND branch_id = $2`, [id, branchId])).rowCount) continue;
      await withTx(db, (tx) => setGameBranch(tx, ctx, id, branchId, { available, note: available ? null : 'Нет на этом филиале (демо)' }, meta, clock));
      created.availability++;
    }
  }

  // страницы: строку по ключу создаёт ensurePage, текст – черновик и публикация; уже живую страницу не трогаем
  for (const p of PAGES) {
    const row = await withTx(db, (tx) => ensurePage(tx, ctx, p.key, p.city ? cities.get(p.city)! : null, meta, clock));
    if (row.status !== 'draft') continue;
    await withTx(db, async (tx) => {
      const saved = await saveDraft(tx, ctx, pageDef, row.id, { rowVersion: row.row_version, draft: { title: p.title, body: p.body } }, meta, clock);
      await publish(tx, ctx, pageDef, row.id, { rowVersion: saved.row_version }, meta, clock);
    });
    created.pages++;
  }

  // две кампании – черновики: реклама на сегмент Красного и личное сообщение демо-клиенту
  const deps = { pool, clock, network: { branchesOfCities: branchIdsOfCities, timezonesOf }, bookings: bookingLookup, unsubscribeSecret: null };
  const campaigns: Array<{ key: string; input: CampaignInput }> = [
    {
      key: 'campaign-segment',
      input: { category: 'marketing', title: 'Ночной пакет со скидкой (демо)', body: '{client.firstName}, ночной пакет в {branch.name} дешевле на 20% (демо).', erid: 'DEMO-ERID-1', audience: { kind: 'segment', segment: { v: 1, area: { branchIds: [krasny.id] } } } },
    },
    {
      key: 'campaign-personal',
      input: { category: 'marketing', purpose: 'Приглашение на турнир (демо)', title: 'Турнир в субботу (демо)', body: 'Ждём вас на турнире в субботу (демо).', erid: 'DEMO-ERID-2', audience: { kind: 'client', clientId: client.id } },
    },
  ];
  for (const c of campaigns) {
    const note = mark(c.key);
    const found = await pool.query<{ id: string }>(`SELECT id FROM app.notification_campaigns WHERE advertiser_note = $1`, [note]);
    if (found.rows[0]) {
      report.campaignIds.push(found.rows[0].id);
      continue;
    }
    const r = await createCampaign(deps, ctx, meta, { ...c.input, advertiserNote: note }, randomUUID());
    report.campaignIds.push((r.body as { id: string }).id);
    created.campaigns++;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertNotProduction(process.env);
  const url = process.env.DATABASE_URL;
  const mediaDir = process.env.MEDIA_DIR;
  if (!url || !mediaDir) throw new Error('Нужны DATABASE_URL (рантайм-учётка yu_app) и MEDIA_DIR (каталог медиатеки API)');
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=app,journal', max: 3 });
  seedContent(pool, { env: process.env, mediaDir }).then(
    async (r) => {
      console.log(`Засев Э4: создано ${JSON.stringify(r.created)}`);
      await pool.end();
    },
    async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await pool.end();
      process.exit(1);
    },
  );
}
