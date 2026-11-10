// Состояние и правила сущностей мока CMS (S4-84…S4-89): то, что у сервера в versions.ts, publications.ts, games.ts, pages.ts, blocks.ts –
// схема черновика (облегчённо), полнота K22 §9, ссылки на медиа, засев. Маршруты – mock-content.ts и mock-media.ts.
import type { FastifyRequest } from 'fastify';
import type { ContentStatus } from '../src/lib/content-dto.ts';
import { createHash } from 'node:crypto';

export type Rec = Record<string, unknown>;
export interface Staffish { id: string; role: string; firstName?: string; lastName?: string }
export interface ContentMockDeps {
  current: (req: FastifyRequest) => Staffish;
  zone: (s: Staffish) => { network: boolean; cityIds: string[]; branchIds: string[] };
  can: (s: Staffish, action: string) => boolean;
  branches: () => Array<{ id: string; cityId: string }>;
}

/** K1 (permissions.ts, строки content.*): О – всё, Д – без сети, юридических и очистки, А – просмотр, черновик, загрузка, предпросмотр. */
export const CONTENT_ACTIONS = {
  owner: ['content.view', 'content.draft.edit', 'content.publish', 'content.network.manage', 'content.catalog.availability', 'content.legal.publish', 'content.media.upload', 'content.media.archive', 'content.media.purge', 'content.preview'],
  director: ['content.view', 'content.draft.edit', 'content.publish', 'content.catalog.availability', 'content.media.upload', 'content.media.archive', 'content.preview'],
  admin: ['content.view', 'content.draft.edit', 'content.media.upload', 'content.preview'],
};

export class Fail extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Rec;
  constructor(status: number, code: string, message: string, details?: Rec) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}
export const notFound = () => new Fail(404, 'NOT_FOUND', 'Не найдено');
export const forbidden = (action: string) => new Fail(403, 'FORBIDDEN', 'Недостаточно прав', { action });
export const invalid = (issues: Array<{ path: string; message: string }>) => new Fail(400, 'VALIDATION_FAILED', 'Неверные данные запроса', { issues });
export const contentInvalid = (path: string, message: string) => new Fail(400, 'CONTENT_INVALID', 'Черновик заполнен неверно', { issues: [{ path, message }] });
export const statusConflict = (status: string, action: string) => new Fail(409, 'CONTENT_STATUS_CONFLICT', 'Действие недоступно в этом статусе', { status, action });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MEDIA_LINK = /!\[[^\]]*\]\(media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;
export const RAW_HTML = /<\/?[a-z!?][^>]*>/i;
export const MAX_BYTES = 10 * 1024 * 1024;
export const PUBLICATION_TYPES = ['news', 'promotion', 'giveaway', 'tournament'];
export const STATUSES = ['draft', 'published', 'unpublished', 'archived'];
export const DIRECTIONS = ['pc', 'vr', 'playstation'];
export const LEGAL_KEYS = ['privacy-policy', 'personal-data-consent', 'cookie-policy', 'advertising-consent'];
export const PAGE_KEYS = ['about', 'contacts_intro', 'rules', ...LEGAL_KEYS];
export const BLOCK_TYPES = ['hero', 'about', 'directions', 'advantages', 'promo_strip', 'cta'];
export const SLUG_MAX: Record<string, number> = { city: 40, branch: 64, room: 64, game: 90, publication: 90 };

export type EntityType = 'publication' | 'game' | 'room_page' | 'branch_page' | 'content_page' | 'home_block';
export type Scope = { type: 'network' } | { type: 'city'; cityIds: string[] } | { type: 'branch'; branchIds: string[] };
export interface Row {
  id: string; type: EntityType; status: ContentStatus; draft: Rec; rowVersion: number; liveVersionId: string | null; draftUpdatedAt: string; draftUpdatedBy: string;
  createdAt: string; archivedAt: string | null; col: Rec; liveScope: Scope | null; branches: Map<string, { available: boolean; note: string | null }>;
}
export interface Version { id: string; entityType: EntityType; entityId: string; versionNo: number; action: 'publish' | 'rollback_publish'; publishedBy: string; publishedByName: string | null; publishedAt: string; reason: string | null; sourceVersionId: string | null; snapshot: Rec }
export interface Media { id: string; sha256: string; mime: string; bytes: number; width: number | null; height: number | null; alt: string | null; title: string | null; originalName: string | null; purpose: 'image' | 'document'; status: 'active' | 'archived'; createdAt: string; archivedAt: string | null; rowVersion: number }
export interface Ref { mediaId: string; field: string; altRequired: boolean }

export const CONTENT_IDS = {
  mediaCover: '0a000000-0000-4000-8000-000000000001', mediaNoAlt: '0a000000-0000-4000-8000-000000000002', mediaRules: '0a000000-0000-4000-8000-000000000003',
  pubNetwork: '0b000000-0000-4000-8000-000000000001', pubCity: '0b000000-0000-4000-8000-000000000002', pubBranch: '0b000000-0000-4000-8000-000000000003', pubTomsk: '0b000000-0000-4000-8000-000000000004',
  gameCs: '0c000000-0000-4000-8000-000000000001', gameVr: '0c000000-0000-4000-8000-000000000002',
  pagePrivacy: '0d000000-0000-4000-8000-000000000001', blockHero: '0e000000-0000-4000-8000-000000000001', blockAbout: '0e000000-0000-4000-8000-000000000002',
};

/** Состояние CMS мока: строки сущностей, журнал версий, медиатека, история адресов. Сбрасывается resetContent(). */
export const cms = { rows: [] as Row[], versions: [] as Version[], media: [] as Media[], history: [] as Array<{ entityType: string; entityId: string; parentKey: string; oldSlug: string; createdAt: string }>, seq: 100 };
export const replays = new Map<string, { status: number; body: unknown }>();

export const storageKey = (m: Media) => `${m.sha256.slice(0, 2)}/${m.sha256.slice(2, 4)}/${m.sha256}${m.purpose === 'document' ? '.pdf' : '-1600.webp'}`;
export const at = (iso: string) => new Date(iso).toISOString();
export function mkRow(id: string, type: EntityType, draft: Rec, col: Rec = {}, createdAt = '2026-10-20T05:00:00Z'): Row {
  return { id, type, status: 'draft', draft, rowVersion: 1, liveVersionId: null, draftUpdatedAt: at(createdAt), draftUpdatedBy: 's-owner', createdAt: at(createdAt), archivedAt: null, col, liveScope: null, branches: new Map() };
}
export function mkMedia(id: string, name: string, alt: string | null, purpose: 'image' | 'document' = 'image', createdAt = '2026-10-15T05:00:00Z'): Media {
  return { id, sha256: createHash('sha256').update(id).digest('hex'), mime: purpose === 'image' ? 'image/jpeg' : 'application/pdf', bytes: 240_000, width: purpose === 'image' ? 1600 : null, height: purpose === 'image' ? 900 : null, alt, title: null, originalName: name, purpose, status: 'active', createdAt: at(createdAt), archivedAt: null, rowVersion: 1 };
}
export function frozen(snapshotDraft: Rec, type: EntityType): Rec {
  const m: Rec = {};
  for (const r of refsOf(type, snapshotDraft)) {
    const x = cms.media.find((y) => y.id === r.mediaId);
    if (x) m[x.id] = { alt: x.alt, mime: x.mime, width: x.width, height: x.height, key: storageKey(x), variants: [] };
  }
  return m;
}
export function seedVersion(row: Row, draft: Rec, publishedAt: string, reason: string | null = null): void {
  const no = cms.versions.filter((v) => v.entityType === row.type && v.entityId === row.id).length + 1;
  const v: Version = { id: String(cms.seq++), entityType: row.type, entityId: row.id, versionNo: no, action: 'publish', publishedBy: 's-owner', publishedByName: 'Ольга Владимирова', publishedAt: at(publishedAt), reason, sourceVersionId: null, snapshot: { ...draft, media: frozen(draft, row.type) } };
  cms.versions.push(v);
  row.status = 'published';
  row.liveVersionId = v.id;
  row.draft = { ...draft };
  row.rowVersion += 1;
}

export function resetContent(): void {
  const I = CONTENT_IDS;
  cms.seq = 100;
  cms.history = [];
  replays.clear();
  cms.media = [
    mkMedia(I.mediaCover, 'cs2-turnir.jpg', 'Игроки за компьютерами на турнире по CS2', 'image', '2026-10-15T05:00:00Z'),
    mkMedia(I.mediaNoAlt, 'zal-krasny.jpg', null, 'image', '2026-10-16T05:00:00Z'),
    mkMedia(I.mediaRules, 'pravila-rozygrysha.pdf', null, 'document', '2026-10-17T05:00:00Z'),
  ];
  cms.versions = [];
  const net = mkRow(I.pubNetwork, 'publication', {}, { pubType: 'news' }, '2026-10-01T05:00:00Z');
  const base = { scope: { type: 'network' }, title: 'Открыли сезон турниров', lead: 'Турниры каждую субботу во всех клубах сети.', body: 'Регистрация – на стойке администратора.', slug: 'tournament-season', publishFrom: '2026-10-01T03:00:00.000Z', coverMediaId: I.mediaCover };
  seedVersion(net, base, '2026-10-01T06:00:00Z');
  seedVersion(net, { ...base, title: 'Открыли сезон турниров 2026', lead: 'Турниры каждую субботу во всех клубах сети Ю-Клуб.' }, '2026-10-05T06:00:00Z', 'Уточнили год');
  net.col.slug = 'tournament-season';
  net.liveScope = { type: 'network' };
  const city = mkRow(I.pubCity, 'publication', { scope: { type: 'city', cityIds: ['c-nsk'] }, title: 'Скидка 20% по будням', lead: 'До 17:00 в клубах Новосибирска.' }, { pubType: 'promotion' }, '2026-10-10T05:00:00Z');
  const branch = mkRow(I.pubBranch, 'publication', { scope: { type: 'branch', branchIds: ['b-nsk-krasny'] }, title: 'Новые кресла на Красном' }, { pubType: 'news' }, '2026-10-12T05:00:00Z');
  const tomsk = mkRow(I.pubTomsk, 'publication', {}, { pubType: 'news' }, '2026-10-14T05:00:00Z');
  seedVersion(tomsk, { scope: { type: 'branch', branchIds: ['b-tsk-lenina'] }, title: 'Открытие в Томске', lead: 'Клуб на Ленина открыт.', body: 'Ждём вас.', slug: 'tomsk-opening', publishFrom: '2026-10-14T03:00:00.000Z', coverMediaId: I.mediaCover }, '2026-10-14T06:00:00Z');
  tomsk.col.slug = 'tomsk-opening';
  tomsk.liveScope = { type: 'branch', branchIds: ['b-tsk-lenina'] };
  const cs = mkRow(I.gameCs, 'game', {}, { direction: 'pc', sortOrder: 10 });
  seedVersion(cs, { title: 'Counter-Strike 2', short: 'Командный шутер 5 на 5.', full: 'Соревновательный режим и турниры.', slug: 'counter-strike-2', coverMediaId: I.mediaCover, genres: ['шутер'], ageRating: '16+' }, '2026-10-02T06:00:00Z');
  cs.col.slug = 'counter-strike-2';
  cs.branches.set('b-nsk-krasny', { available: true, note: null });
  cs.branches.set('b-tsk-lenina', { available: true, note: 'только по выходным' });
  const vr = mkRow(I.gameVr, 'game', { title: 'Beat Saber', short: 'Ритм-игра со световыми мечами.' }, { direction: 'vr', sortOrder: 20 });
  const privacy = mkRow(I.pagePrivacy, 'content_page', {}, { key: 'privacy-policy', cityId: null });
  seedVersion(privacy, { title: 'Политика конфиденциальности', body: 'Оператор персональных данных – ООО «Ю-Клуб».', documentVersion: 'privacy-policy-2026-10-01' }, '2026-10-01T06:00:00Z');
  privacy.col.documentVersion = 'privacy-policy-2026-10-01';
  const hero = mkRow(I.blockHero, 'home_block', {}, { blockType: 'hero', cityId: null, sortOrder: 0 });
  seedVersion(hero, { blockType: 'hero', payload: { title: 'Компьютерный клуб Ю-Клуб', subtitle: 'ПК, VR и PlayStation', ctaLabel: 'Записаться', ctaUrl: '/booking/' } }, '2026-10-01T06:00:00Z');
  const about = mkRow(I.blockAbout, 'home_block', { blockType: 'about', payload: { title: 'О клубе', body: 'Мы открылись в 2020 году.' } }, { blockType: 'about', cityId: null, sortOrder: 1 });
  cms.rows = [net, city, branch, tomsk, cs, vr, privacy, hero, about];
}

// ---- правила сущностей (как EntityDef у сервера)

export const mediaInText = (t: unknown) => (typeof t === 'string' ? [...t.matchAll(MEDIA_LINK)].map((m) => m[1]!.toLowerCase()) : []);
export function richTextOf(type: EntityType, d: Rec): Array<[string, unknown]> {
  const p = (d.payload ?? {}) as Rec;
  switch (type) {
    case 'publication': return [['body', d.body], ['rulesBody', d.rulesBody], ['conditions', d.conditions], ['restrictions', d.restrictions]];
    case 'game': return [['full', d.full]];
    case 'content_page': return [['body', d.body]];
    case 'room_page': return [['description', d.description], ['rentFormatsText', d.rentFormatsText]];
    case 'branch_page': return [['description', d.description], ['howToGet', d.howToGet]];
    case 'home_block': return d.blockType === 'about' ? [['payload.body', p.body]] : d.blockType === 'promo_strip' ? [['payload.text', p.text]] : [];
  }
}
export function refsOf(type: EntityType, d: Rec): Ref[] {
  const refs: Ref[] = [];
  const one = (id: unknown, field: string, altRequired: boolean) => typeof id === 'string' && refs.push({ mediaId: id, field, altRequired });
  if (type === 'publication') { one(d.coverMediaId, 'cover', true); one(d.ogMediaId, 'og', false); one(d.rulesMediaId, 'rules', false); }
  if (type === 'game') { one(d.coverMediaId, 'cover', true); one(d.ogMediaId, 'og', false); }
  if (type === 'content_page') one(d.ogMediaId, 'og', false);
  if (type === 'room_page' || type === 'branch_page') { ((d.gallery as string[] | undefined) ?? []).forEach((id, i) => one(id, `gallery.${i}`, true)); one(d.ogMediaId, 'og', false); }
  if (type === 'home_block') {
    const p = (d.payload ?? {}) as Rec;
    if (d.blockType === 'hero') one(p.mediaId, 'payload.mediaId', true);
    ((p.items as Rec[] | undefined) ?? []).forEach((it, i) => one(it.mediaId, `payload.items.${i}.mediaId`, true));
  }
  const seen = new Set(refs.map((r) => `${r.field}:${r.mediaId}`));
  for (const [field, text] of richTextOf(type, d)) for (const id of mediaInText(text)) if (!seen.has(`${field}:${id}`)) { seen.add(`${field}:${id}`); refs.push({ mediaId: id, field, altRequired: true }); }
  return refs;
}

export const SEO = { seoTitle: 120, seoDescription: 300, h1: 90 };
export const FIELDS: Record<EntityType, Record<string, 'str' | number | 'iso' | 'uuid' | 'bool' | 'strs' | 'uuids' | 'scope' | 'int' | 'obj' | 'path'>> = {
  publication: { scope: 'scope', title: 120, lead: 300, body: 'str', slug: 200, coverMediaId: 'uuid', publishFrom: 'iso', publishTo: 'iso', eventDate: 'iso', conditions: 5000, restrictions: 5000, ctaLabel: 60, ctaUrl: 'path', resultsDate: 'iso', prize: 500, rulesBody: 'str', rulesMediaId: 'uuid', indexable: 'bool', ...SEO, ogMediaId: 'uuid' },
  game: { title: 120, short: 200, full: 'str', slug: 200, coverMediaId: 'uuid', genres: 'strs', ageRating: 'str', platforms: 'strs', sortOrder: 'int', ...SEO, ogMediaId: 'uuid' },
  content_page: { title: 200, body: 'str', documentVersion: 80, ...SEO, ogMediaId: 'uuid' },
  room_page: { description: 'str', gallery: 'uuids', features: 'strs', rentFormatsText: 2000, ...SEO, ogMediaId: 'uuid' },
  branch_page: { description: 'str', gallery: 'uuids', features: 'strs', howToGet: 2000, postal: 'obj', geo: 'obj', ...SEO, ogMediaId: 'uuid' },
  home_block: { blockType: 'str', payload: 'obj', ...SEO, ogMediaId: 'uuid' },
};
/** Облегчённая схема черновика: strictObject, типы и пределы длины (zod у сервера). Охват публикации обязателен с первого сохранения. */
export function parseDraft(type: EntityType, value: unknown): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contentInvalid('', 'ожидается объект');
  const d = value as Rec;
  for (const [k, v] of Object.entries(d)) {
    const rule = FIELDS[type][k];
    if (!rule) throw contentInvalid(k, 'лишнее поле');
    const bad = () => contentInvalid(k, 'неверное значение');
    if (typeof rule === 'number' && (typeof v !== 'string' || v.length > rule)) throw typeof v === 'string' ? contentInvalid(k, `не длиннее ${rule} знаков`) : bad();
    if (rule === 'str' && typeof v !== 'string') throw bad();
    if (rule === 'iso' && (typeof v !== 'string' || !ISO.test(v))) throw bad();
    if (rule === 'uuid' && (typeof v !== 'string' || !UUID.test(v))) throw bad();
    if (rule === 'bool' && typeof v !== 'boolean') throw bad();
    if (rule === 'int' && !Number.isInteger(v)) throw bad();
    if (rule === 'path' && (typeof v !== 'string' || !/^\/(?![/\\])[^\s\\]*$/.test(v))) throw contentInvalid(k, 'только путь этого сайта');
    if ((rule === 'strs' || rule === 'uuids') && (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || (rule === 'uuids' && !UUID.test(x))))) throw bad();
    if (rule === 'obj' && (!v || typeof v !== 'object')) throw bad();
  }
  if (type === 'publication') {
    const s = d.scope as Rec | undefined;
    if (!s || !['network', 'city', 'branch'].includes(String(s.type))) throw contentInvalid('scope', 'укажите охват');
    if (s.type === 'city' && (!Array.isArray(s.cityIds) || s.cityIds.length === 0)) throw contentInvalid('scope.cityIds', 'выберите город');
    if (s.type === 'branch' && (!Array.isArray(s.branchIds) || s.branchIds.length === 0)) throw contentInvalid('scope.branchIds', 'выберите филиал');
  }
  if (type === 'home_block') {
    if (!BLOCK_TYPES.includes(String(d.blockType))) throw contentInvalid('blockType', 'неизвестный тип блока');
    const p = d.payload as Rec;
    const need: Record<string, string[]> = { hero: ['title'], about: ['body'], directions: ['items'], advantages: ['items'], promo_strip: ['text'], cta: ['title', 'label', 'url'] };
    for (const f of need[String(d.blockType)]!) if (p[f] === undefined || p[f] === '' || (Array.isArray(p[f]) && (p[f] as unknown[]).length === 0)) throw contentInvalid(`payload.${f}`, 'обязательное поле');
    for (const u of ['ctaUrl', 'url']) if (typeof p[u] === 'string' && !/^\/(?![/\\])[^\s\\]*$/.test(p[u])) throw contentInvalid(`payload.${u}`, 'только путь этого сайта');
  }
  for (const [field, text] of richTextOf(type, d)) {
    if (typeof text !== 'string') continue;
    if (text.length > 50_000) throw new Fail(422, 'RICH_TEXT_TOO_LONG', 'Текст длиннее 50000 знаков', { field, max: 50_000 });
    if (RAW_HTML.test(text)) throw new Fail(422, 'RICH_TEXT_HTML_FORBIDDEN', 'В тексте нельзя использовать HTML', { field });
  }
  return d;
}

export const str = (v: unknown) => String(v ?? '').trim();
export function complete(row: Row, d: Rec): Array<{ field: string; code: string }> {
  const req = (fields: string[]) => fields.filter((f) => !str(d[f])).map((field) => ({ field, code: 'REQUIRED' }));
  if (row.type === 'publication') {
    const f = ['title', 'lead', 'body', 'slug', 'publishFrom', 'coverMediaId'];
    if (row.col.pubType === 'promotion') f.push('publishTo', 'conditions');
    if (row.col.pubType === 'giveaway') f.push('resultsDate', 'prize');
    const issues = req(f);
    if (row.col.pubType === 'giveaway' && !str(d.rulesBody) && !d.rulesMediaId) issues.push({ field: 'rules', code: 'REQUIRED' });
    if (d.publishFrom && d.publishTo && Date.parse(String(d.publishTo)) <= Date.parse(String(d.publishFrom))) issues.push({ field: 'publishTo', code: 'BEFORE_START' });
    return issues;
  }
  if (row.type === 'game') {
    const issues = req(['title', 'short', 'coverMediaId']);
    if (row.col.direction === 'playstation' && !(d.platforms as unknown[] | undefined)?.length) issues.push({ field: 'platforms', code: 'REQUIRED' });
    if (str(d.full) && !str(d.slug)) issues.push({ field: 'slug', code: 'REQUIRED' });
    return issues;
  }
  if (row.type === 'content_page') {
    const issues = req(['title', 'body']);
    const key = String(row.col.key);
    if (LEGAL_KEYS.includes(key)) {
      if (!d.documentVersion) issues.push({ field: 'documentVersion', code: 'REQUIRED' });
      else if (!/^[a-z-]+-\d{4}-\d{2}-\d{2}(-\d+)?$/.test(String(d.documentVersion)) || !String(d.documentVersion).startsWith(`${key}-`)) issues.push({ field: 'documentVersion', code: 'FORMAT' });
    }
    return issues;
  }
  if (row.type === 'room_page' || row.type === 'branch_page') return req(['description']);
  return [];
}
