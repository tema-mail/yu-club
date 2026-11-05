// S4-50. История адресов и разбор пути (K23 §3, §5): старые слаги по сегментам пути, разрешение старого адреса в текущий канонический
// (цепочки A → B → C схлопываются: старые A и B ведут сразу на C), закрытые объекты, черновой транслит, проверка слага для CRM.
// Шаблоны адресов – только реестр packages/contracts/src/paths.ts. Живой объект важнее редиректа: сегмент сначала ищется среди текущих
// слагов, потом в истории, поэтому занятый новым объектом старый слаг ведёт на новый объект.
// Города, филиалы и комнаты – только чтение: их слаги у network и resources (ADR 0002), историю пишет обработчик событий (handlers.ts).
import type { Db } from '../../core/audit.ts';
import { resolveSettings } from '../../core/settings.ts';
import { systemClock, type Clock } from '../../core/time.ts';
import {
  RESERVED_CITY_SLUGS, SLUG_RE, STATIC_PATHS, branchPath, cityPath, gamePath, giveawayRulesPath, normalizePath, pagePath, parsePath, publicationPath, roomPath,
  type GameDirection, type PublicationType,
} from '../../../../../packages/contracts/src/paths.ts';

export type SlugEntity = 'city' | 'branch' | 'room' | 'game' | 'publication';

/** Длина слага по сущности (K23 §3): город – 40; игра и публикация – 90; филиал и комната – 64, как принимают network и resources. */
export const SLUG_MAX_OF: Record<SlugEntity, number> = { city: 40, branch: 64, room: 64, game: 90, publication: 90 };

export interface SlugChange {
  entityType: SlugEntity;
  entityId: string;
  /** В пределах чего слаг уникален: город – '', филиал – city_id, комната – branch_id, игра – direction, публикация – type. */
  parentKey: string;
  oldSlug: string;
  newSlug: string;
}

/** Старый слаг → в историю. Возврат к слагу из истории снимает его строку; конфликт по старому слагу – адрес ведёт на того, кто ушёл с него последним. */
export async function recordSlugChange(tx: Db, c: SlugChange, clock: Clock = systemClock): Promise<void> {
  if (c.oldSlug === c.newSlug) return;
  await releaseSlug(tx, c.entityType, c.parentKey, c.newSlug);
  await tx.query(
    `INSERT INTO app.seo_slug_history (entity_type, entity_id, parent_key, old_slug, created_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (entity_type, parent_key, old_slug) DO UPDATE SET entity_id = EXCLUDED.entity_id, created_at = EXCLUDED.created_at`,
    [c.entityType, c.entityId, c.parentKey, c.oldSlug, clock.now()],
  );
}

/** Новый объект занял слаг из истории: строка снимается в той же транзакции (K23 §5). */
export async function releaseSlug(tx: Db, entityType: SlugEntity, parentKey: string, slug: string): Promise<void> {
  await tx.query(`DELETE FROM app.seo_slug_history WHERE entity_type = $1 AND parent_key = $2 AND old_slug = $3`, [entityType, parentKey, slug]);
}

// ---- разрешение пути

interface NodeRow {
  id: string;
  slug: string;
  status: string;
}
type RoomRow = NodeRow & { is_published: boolean };

/** Сегмент: сначала текущий слаг у родителя, затем история в пределах родителя (K23 §5). */
async function findNode<T extends NodeRow>(db: Db, type: SlugEntity, table: string, columns: string, parent: { column: string; key: string } | null, slug: string): Promise<T | null> {
  const select = columns.split(',').map((c) => `t.${c.trim()}`).join(', ');
  const current = parent
    ? await db.query<T>(`SELECT ${select} FROM ${table} t WHERE t.${parent.column}::text = $1 AND t.slug = $2`, [parent.key, slug])
    : await db.query<T>(`SELECT ${select} FROM ${table} t WHERE t.slug = $1`, [slug]);
  if (current.rows[0]) return current.rows[0];
  const old = await db.query<T>(
    `SELECT ${select} FROM app.seo_slug_history h JOIN ${table} t ON t.id = h.entity_id WHERE h.entity_type = $1 AND h.parent_key = $2 AND h.old_slug = $3`,
    [type, parent?.key ?? '', slug],
  );
  return old.rows[0] ?? null;
}

const findCity = (db: Db, slug: string) => findNode<NodeRow>(db, 'city', 'app.cities', 'id, slug, status', null, slug);
const findBranch = (db: Db, cityId: string, slug: string) => findNode<NodeRow>(db, 'branch', 'app.branches', 'id, slug, status', { column: 'city_id', key: cityId }, slug);
const findRoom = (db: Db, branchId: string, slug: string) => findNode<RoomRow>(db, 'room', 'app.rooms', 'id, slug, status, is_published', { column: 'branch_id', key: branchId }, slug);

/** Открытые филиалы города – те, что есть на сайте; по ним решается, есть ли страница города (K23 §2, правило «не дорвеи»). */
async function openBranches(db: Db, cityId: string): Promise<Array<{ slug: string }>> {
  const r = await db.query<{ slug: string }>(`SELECT slug FROM app.branches WHERE city_id = $1 AND status IN ('active','temporarily_closed') ORDER BY sort_order, name, id LIMIT 2`, [cityId]);
  return r.rows;
}

/** Куда ведёт адрес города: архив – главная; один филиал – сразу он; два и больше – страница города; ни одного – страницы нет. */
async function cityTarget(db: Db, city: NodeRow): Promise<string | null> {
  if (city.status === 'archived') return STATIC_PATHS.home;
  const open = await openBranches(db, city.id);
  if (open.length === 0) return null;
  return open.length === 1 ? branchPath(city.slug, open[0]!.slug) : cityPath(city.slug);
}

/** Куда ведёт адрес филиала (K23 §5): архив – город, если у него есть страница, иначе контакты; готовящегося на сайте ещё нет. */
async function branchTarget(db: Db, city: NodeRow, branch: NodeRow): Promise<string | null> {
  if (branch.status === 'archived') {
    const open = city.status === 'archived' ? [] : await openBranches(db, city.id);
    return open.length >= 2 ? cityPath(city.slug) : STATIC_PATHS.contacts;
  }
  return branch.status === 'preparing' ? null : branchPath(city.slug, branch.slug);
}

type PublicationRow = NodeRow & { publish_from: Date | null; publish_to: Date | null };
type GameRow = NodeRow & { has_full: boolean };

/** Текущий слаг публикации, если у неё сейчас есть страница (те же условия, что getPublicationPage). */
async function publicationSlug(db: Db, type: PublicationType, slug: string, now: Date): Promise<string | null> {
  const row = await findNode<PublicationRow>(db, 'publication', 'app.content_publications', 'id, slug, status, publish_from, publish_to', { column: 'type', key: type }, slug);
  if (!row || row.status !== 'published' || !row.publish_from || row.publish_from > now) return null;
  if (row.publish_to && row.publish_to <= now) {
    const s = await resolveSettings(db, ['content.ended_promotion_mode'], { network: true }, now);
    if (s['content.ended_promotion_mode'].value === 'not_found') return null;
  }
  return row.slug;
}

async function gameSlug(db: Db, direction: GameDirection, slug: string): Promise<string | null> {
  const row = await findNode<GameRow>(db, 'game', 'app.content_games', 'id, slug, status, has_full', { column: 'direction', key: direction }, slug);
  return row && row.status === 'published' && row.has_full ? row.slug : null;
}

/** Текущий канонический адрес запрошенного пути (с возможной долей #rooms). null – такого адреса не было, либо у сущности сейчас нет страницы. */
async function canonicalOf(db: Db, pathname: string, now: Date): Promise<string | null> {
  const m = parsePath(pathname);
  if (!m) return null;
  switch (m.kind) {
    case 'city':
    case 'branch':
    case 'branchRooms':
    case 'room': {
      const city = await findCity(db, m.city);
      if (!city) return null;
      if (m.kind === 'city') return cityTarget(db, city);
      const branch = await findBranch(db, city.id, m.branch);
      if (!branch) return null;
      const room = m.kind === 'room' ? await findRoom(db, branch.id, m.room) : null;
      if (m.kind === 'room' && !room) return null;
      const target = await branchTarget(db, city, branch);
      if (target !== branchPath(city.slug, branch.slug)) return target; // филиал закрыт насовсем или ещё не открыт
      if (m.kind === 'branch') return target;
      if (m.kind === 'branchRooms') return `${target}#rooms`; // сразу на раздел: второго перехода через /rooms/ нет (карта п.2.11)
      return room!.status === 'active' && room!.is_published ? roomPath(city.slug, branch.slug, room!.slug) : target; // снята с сайта или закрыта – страница филиала
    }
    case 'game': {
      const slug = await gameSlug(db, m.direction, m.game);
      return slug ? gamePath(m.direction, slug) : null;
    }
    case 'publication': {
      const slug = await publicationSlug(db, m.type, m.slug, now);
      return slug ? publicationPath(m.type, slug) : null;
    }
    case 'giveawayRules': {
      const slug = await publicationSlug(db, 'giveaway', m.slug, now);
      return slug ? giveawayRulesPath(slug) : null;
    }
    default:
      return null;
  }
}

/** K5 №216. Старый или ненормальный адрес → один переход на текущий; адрес уже канонический или ничего не найдено – null (страница сама решит, 200 или 404). */
export async function resolveLegacyPath(db: Db, pathname: string, now: Date): Promise<{ status: 301; location: string } | null> {
  const location = await canonicalOf(db, normalizePath(pathname), now);
  return location && location !== pathname ? { status: 301, location } : null;
}

// ---- записи карты сайта (K5 №217)

export interface SitemapEntry {
  path: string;
  lastmod: string | null;
}

/** Индексируемые сущности контента по K23 §2: игры с полным описанием, живые публикации с indexable и незавершённым сроком, страницы about, rules, contacts.
 *  Юридические – noindex всегда, в карту не идут. Черновик, снятое и архив отсекает status = 'published'. lastmod – дата живой версии. */
export async function sitemapEntries(db: Db, now: Date): Promise<SitemapEntry[]> {
  const iso = (d: Date) => d.toISOString();
  const games = await db.query<{ direction: GameDirection; slug: string; at: Date }>(
    `SELECT g.direction, g.slug, v.published_at AS at FROM app.content_games g JOIN journal.content_versions v ON v.id = g.live_version_id
      WHERE g.status = 'published' AND g.has_full AND g.slug IS NOT NULL ORDER BY g.direction, g.slug`,
  );
  const pubs = await db.query<{ type: PublicationType; slug: string; at: Date }>(
    `SELECT p.type, p.slug, v.published_at AS at FROM app.content_publications p JOIN journal.content_versions v ON v.id = p.live_version_id
      WHERE p.status = 'published' AND p.indexable AND p.slug IS NOT NULL AND p.publish_from <= $1 AND (p.publish_to IS NULL OR p.publish_to > $1) ORDER BY p.type, p.slug`,
    [now],
  );
  const pages = await db.query<{ key: 'about' | 'rules' | 'contacts_intro'; at: Date }>(
    `SELECT p.key, v.published_at AS at FROM app.content_pages p JOIN journal.content_versions v ON v.id = p.live_version_id
      WHERE p.status = 'published' AND p.city_id IS NULL AND p.key IN ('about','rules','contacts_intro') ORDER BY p.key`,
  );
  return [
    ...pages.rows.map((x) => ({ path: pagePath(x.key), lastmod: iso(x.at) })),
    ...games.rows.map((x) => ({ path: gamePath(x.direction, x.slug), lastmod: iso(x.at) })),
    ...pubs.rows.map((x) => ({ path: publicationPath(x.type, x.slug), lastmod: iso(x.at) })),
  ];
}

// ---- черновой транслит (K23 §3)

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Черновой слаг из заголовка: ГОСТ 7.79-2000 Б с правками Яндекса; русские слова из 1–2 букв отбрасываются (в, на, по), латиница и цифры остаются (VR, 5); обрезка по целому слову. */
export function slugDraft(title: string, max: number = SLUG_MAX_OF.publication): string {
  const words = title.toLowerCase().match(/[a-zа-яё0-9]+/g) ?? [];
  let out = '';
  for (const word of words) {
    if (/^[а-яё]{1,2}$/.test(word)) continue;
    const latin = [...word].map((ch) => TRANSLIT[ch] ?? ch).join('');
    if (!latin) continue;
    const next = out ? `${out}-${latin}` : latin;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

// ---- проверка слага для CRM (K11 №237)

const OWNER_TABLE: Record<SlugEntity, { table: string; parent: string | null }> = {
  city: { table: 'app.cities', parent: null },
  branch: { table: 'app.branches', parent: 'city_id' },
  room: { table: 'app.rooms', parent: 'branch_id' },
  game: { table: 'app.content_games', parent: 'direction' },
  publication: { table: 'app.content_publications', parent: 'type' },
};

export type SlugCheck = { ok: true; code?: 'SLUG_IN_HISTORY' } | { ok: false; code: 'SLUG_INVALID' | 'SLUG_RESERVED' } | { ok: false; code: 'SLUG_TAKEN'; suggestion: string };

/** Маска и длина → зарезервированное (город) → занят у родителя с подсказкой -2, -3… → предупреждение об истории (адрес раньше вёл на другой объект). */
export async function checkSlug(db: Db, q: { entityType: SlugEntity; parent: string; slug: string; excludeId?: string | undefined }): Promise<SlugCheck> {
  if (!SLUG_RE.test(q.slug) || q.slug.length > SLUG_MAX_OF[q.entityType]) return { ok: false, code: 'SLUG_INVALID' };
  if (q.entityType === 'city' && (RESERVED_CITY_SLUGS as readonly string[]).includes(q.slug)) return { ok: false, code: 'SLUG_RESERVED' };
  const { table, parent } = OWNER_TABLE[q.entityType];
  const free = async (slug: string): Promise<boolean> => {
    const params: unknown[] = [slug, q.excludeId ?? null];
    const inParent = parent ? ` AND ${parent}::text = $3` : '';
    if (parent) params.push(q.parent);
    return (await db.query(`SELECT 1 FROM ${table} WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)${inParent}`, params)).rows.length === 0;
  };
  if (!(await free(q.slug))) {
    let n = 2;
    while (!(await free(`${q.slug}-${n}`))) n += 1;
    return { ok: false, code: 'SLUG_TAKEN', suggestion: `${q.slug}-${n}` };
  }
  const history = await db.query(
    `SELECT 1 FROM app.seo_slug_history WHERE entity_type = $1 AND parent_key = $2 AND old_slug = $3 AND ($4::uuid IS NULL OR entity_id <> $4::uuid)`,
    [q.entityType, parent ? q.parent : '', q.slug, q.excludeId ?? null],
  );
  return history.rows.length > 0 ? { ok: true, code: 'SLUG_IN_HISTORY' } : { ok: true };
}

/** История адреса сущности для вкладки «Адрес» в CRM (K11 №238): новые сверху. */
export async function slugHistory(db: Db, entityType: SlugEntity, entityId: string): Promise<Array<{ oldSlug: string; createdAt: string }>> {
  const r = await db.query<{ old_slug: string; created_at: Date }>(`SELECT old_slug, created_at FROM app.seo_slug_history WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC, id DESC`, [entityType, entityId]);
  return r.rows.map((x) => ({ oldSlug: x.old_slug, createdAt: x.created_at.toISOString() }));
}
