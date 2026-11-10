// Мок CMS для экранов «Контент» (S4-84…S4-89) строго по apps/api/src/modules/content: routes.crm.publications.ts (№213–218, №233),
// routes.crm.catalog.ts (№219–223, №228, №236–238), routes.media.ts (№224–227) и правилам versions.ts, publications.ts, games.ts,
// pages.ts, blocks.ts, paths.ts. Как у сервера: вне зоны – 404, сеть без права – 403, команды под Idempotency-Key (повтор – тот же ответ),
// черновик – rowVersion (VERSION_CONFLICT с details.current), полнота – CONTENT_INCOMPLETE с details.fields, alt – MEDIA_ALT_REQUIRED.
// Отличия от API (осознанные): id филиалов и городов мока – не UUID (сервер ждёт UUID), схема черновика проверяется облегчённо
// (лишнее поле и неверный тип – CONTENT_INVALID), картинки не перекодируются (вариантов нет, размеры – из PNG или 1600×900).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { BLOCK_TYPES, type ContentMockDeps, DIRECTIONS, type EntityType, Fail, LEGAL_KEYS, PAGE_KEYS, PUBLICATION_TYPES, type Rec, type Ref, type Row, SLUG_MAX, SLUG_RE, STATUSES, type Scope, type Staffish, UUID, type Version, cms, complete, contentInvalid, forbidden, frozen, invalid, mkRow, notFound, parseDraft, refsOf, replays, resetContent, statusConflict, str } from './mock-cms.ts';
import type { AllowedAction, DraftDto, PublicationDto, PublicationType, VersionDto } from '../src/lib/content-dto.ts';
import { registerMedia } from './mock-media.ts';
import { opsState } from './mock-ops.ts';

export { CONTENT_ACTIONS, CONTENT_IDS } from './mock-cms.ts';

export function registerContent(app: FastifyInstance, P: string, d: ContentMockDeps): void {
  resetContent();
  app.addHook('onRequest', async (req) => {
    if (req.method === 'POST' && req.url === '/__test/reset') resetContent();
  });
  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof Fail) return reply.code(e.status).send({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: randomUUID() } });
    throw e;
  };
  const inZone = (s: Staffish, t: 'network' | { cityId: string } | { branchId: string }) => {
    const z = d.zone(s);
    if (z.network) return true;
    if (t === 'network') return false;
    return 'cityId' in t ? z.cityIds.includes(t.cityId) : z.branchIds.includes(t.branchId);
  };
  const canT = (s: Staffish, action: string, t: 'network' | { cityId: string } | { branchId: string }) => d.can(s, action) && inZone(s, t);
  /** assertCan K1: сеть вне зоны – 403, город и филиал вне зоны – 404, в зоне без права – 403. */
  const assertCan = (s: Staffish, action: string, t: 'network' | { cityId: string } | { branchId: string }) => {
    if (!inZone(s, t)) throw t === 'network' ? forbidden(action) : notFound();
    if (!d.can(s, action)) throw forbidden(action);
  };
  const assertRole = (s: Staffish, action: string) => {
    if (!d.can(s, action)) throw forbidden(action);
  };
  const targets = (scope: Scope | undefined): Array<{ cityId: string } | { branchId: string }> =>
    !scope || scope.type === 'network' ? [] : scope.type === 'city' ? scope.cityIds.map((cityId) => ({ cityId })) : scope.branchIds.map((branchId) => ({ branchId }));
  const assertScope = (s: Staffish, scope: Scope, local: string) => {
    if (scope.type === 'network') return assertCan(s, 'content.network.manage', 'network');
    for (const t of targets(scope)) assertCan(s, local, t);
  };
  const branchOfRoom = (roomId: string) => {
    const r = opsState().rooms.find((x) => x.id === roomId);
    if (!r) throw notFound();
    return r.branchId;
  };
  const isLegal = (key: unknown) => LEGAL_KEYS.includes(String(key));
  const blockRight = (s: Staffish, cityId: unknown) => (typeof cityId === 'string' ? assertCan(s, 'content.publish', { cityId }) : assertCan(s, 'content.network.manage', 'network'));

  const assertEdit = (s: Staffish, row: Row, draft: Rec) => {
    if (row.type === 'publication') {
      assertScope(s, draft.scope as Scope, 'content.draft.edit');
      if (row.draft.scope) assertScope(s, row.draft.scope as Scope, 'content.draft.edit');
      if (row.liveScope) assertScope(s, row.liveScope, 'content.draft.edit');
    } else if (row.type === 'game') assertCan(s, 'content.network.manage', 'network');
    else if (row.type === 'content_page') assertCan(s, isLegal(row.col.key) ? 'content.legal.publish' : 'content.network.manage', 'network');
    else if (row.type === 'room_page') assertCan(s, 'content.draft.edit', { branchId: branchOfRoom(String(row.col.roomId)) });
    else if (row.type === 'branch_page') assertCan(s, 'content.draft.edit', { branchId: String(row.col.branchId) });
    else {
      if (draft.blockType !== row.col.blockType) throw contentInvalid('blockType', 'тип блока не меняется');
      blockRight(s, row.col.cityId);
    }
  };
  const assertPublish = (s: Staffish, row: Row, draft: Rec) => {
    if (row.type === 'publication') {
      if (draft.scope) assertScope(s, draft.scope as Scope, 'content.publish');
      if (row.liveScope) assertScope(s, row.liveScope, 'content.publish');
    } else if (row.type === 'room_page') assertCan(s, 'content.publish', { branchId: branchOfRoom(String(row.col.roomId)) });
    else if (row.type === 'branch_page') assertCan(s, 'content.publish', { branchId: String(row.col.branchId) });
    else if (row.type === 'home_block') blockRight(s, row.col.cityId);
    else assertEdit(s, row, draft);
  };
  /** allowedActions сервера: те же условия, что у команды, по охвату черновика и живому охвату. */
  const allowed = (s: Staffish, row: Row) => {
    const scopes = [row.draft.scope as Scope, ...(row.liveScope ? [row.liveScope] : [])];
    const ok = (local: string) => scopes.every((sc) => (sc.type === 'network' ? canT(s, 'content.network.manage', 'network') : targets(sc).every((t) => canT(s, local, t))));
    const out: AllowedAction[] = [];
    if (row.status !== 'archived' && ok('content.draft.edit')) out.push('edit');
    if (ok('content.publish')) {
      if (row.status !== 'archived') out.push('publish');
      if (row.status === 'published') out.push('unpublish');
      if (row.status === 'draft' || row.status === 'unpublished') out.push('archive');
      if (row.status !== 'archived') out.push('rollback');
    }
    return out;
  };
  const viewPublication = (s: Staffish, row: Row) => {
    assertRole(s, 'content.view');
    const t = targets(row.draft.scope as Scope);
    if (t.length > 0 && !t.some((x) => canT(s, 'content.view', x))) throw notFound();
  };

  const dto = (r: Row): DraftDto => ({ id: r.id, status: r.status, draft: r.draft, rowVersion: r.rowVersion, liveVersionId: r.liveVersionId, draftUpdatedAt: r.draftUpdatedAt, draftUpdatedBy: r.draftUpdatedBy, createdAt: r.createdAt, archivedAt: r.archivedAt });
  const emptyDraft = { id: null, status: 'draft', draft: {}, rowVersion: 1, liveVersionId: null } satisfies DraftDto;
  const find = (type: EntityType, id: string) => {
    if (!UUID.test(id)) throw notFound();
    const r = cms.rows.find((x) => x.type === type && x.id === id);
    if (!r) throw notFound();
    return r;
  };
  const checkVersion = (r: Row, v: unknown) => {
    if (r.rowVersion !== v) throw new Fail(409, 'VERSION_CONFLICT', 'Черновик изменился, обновите страницу', { current: dto(r) });
  };
  const usable = (refs: Ref[]) => {
    const bad = refs.filter((x) => !cms.media.some((m) => m.id === x.mediaId));
    if (bad.length) throw new Fail(400, 'CONTENT_INVALID', 'Файла нет в медиатеке', { issues: bad.map((x) => ({ path: x.field, message: 'файла нет в медиатеке' })) });
  };
  const reasonOf = (v: unknown) => {
    const r = str(v);
    if (!r) throw new Fail(422, 'COMMENT_REQUIRED', 'Укажите причину', { field: 'reason' });
    return r;
  };
  const nameOf = (s: Staffish) => (s.firstName ? `${s.firstName} ${s.lastName ?? ''}`.trim() : null);
  const touch = (r: Row, s: Staffish) => {
    r.draftUpdatedAt = new Date().toISOString();
    r.draftUpdatedBy = s.id;
  };
  const strict = (body: unknown, keys: Record<string, (v: unknown) => boolean>, required: string[]) => {
    const b = (body ?? {}) as Rec;
    const issues: Array<{ path: string; message: string }> = [];
    for (const k of Object.keys(b)) if (!keys[k]) issues.push({ path: k, message: 'Unrecognized key' });
    for (const [k, test] of Object.entries(keys)) if (b[k] !== undefined ? !test(b[k]) : required.includes(k)) issues.push({ path: k, message: 'неверное значение' });
    if (issues.length) throw invalid(issues);
    return b;
  };
  const rv = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
  const reasonT = (v: unknown) => typeof v === 'string' && v.length <= 2000;

  function newVersion(row: Row, s: Staffish, snapshot: Rec, action: Version['action'], reason: string | null, source: string | null): Version {
    const v: Version = { id: String(cms.seq++), entityType: row.type, entityId: row.id, versionNo: cms.versions.filter((x) => x.entityType === row.type && x.entityId === row.id).length + 1, action, publishedBy: s.id, publishedByName: nameOf(s), publishedAt: new Date().toISOString(), reason, sourceVersionId: source, snapshot };
    cms.versions.push(v);
    return v;
  }
  /** Живые столбцы: слаг с проверкой и историей адресов (K23 §5), охват публикации, версия документа. */
  function applyLive(row: Row, draft: Rec): void {
    if (row.type === 'publication' || row.type === 'game') {
      const slug = str(draft.slug) || null;
      const parentCol = row.type === 'publication' ? 'pubType' : 'direction';
      if (slug) {
        if (!SLUG_RE.test(slug)) throw new Fail(422, 'SLUG_INVALID', 'Адрес: только латиница, цифры и дефис', { rule: 'mask' });
        if (slug.length > 90) throw new Fail(422, 'SLUG_INVALID', 'Адрес длиннее 90 знаков', { rule: 'length', max: 90 });
        const taken = (x: string) => cms.rows.some((o) => o.type === row.type && o.id !== row.id && o.col[parentCol] === row.col[parentCol] && o.col.slug === x);
        if (taken(slug)) {
          let n = 2;
          while (taken(`${slug}-${n}`)) n += 1;
          throw new Fail(409, 'SLUG_TAKEN', 'Такой адрес уже занят', { suggestion: `${slug}-${n}` });
        }
      }
      const parentKey = String(row.col[parentCol]);
      const old = typeof row.col.slug === 'string' ? row.col.slug : null;
      cms.history = cms.history.filter((h) => !(h.entityType === row.type && h.parentKey === parentKey && h.oldSlug === slug));
      if (old && old !== (slug ?? '')) cms.history.push({ entityType: row.type === 'game' ? 'game' : 'publication', entityId: row.id, parentKey, oldSlug: old, createdAt: new Date().toISOString() });
      row.col.slug = slug;
      if (row.type === 'publication') row.liveScope = draft.scope as Scope;
    }
    if (row.type === 'content_page' && isLegal(row.col.key)) {
      const dv = draft.documentVersion ?? null;
      if (dv && cms.versions.some((v) => v.entityType === 'content_page' && v.entityId === row.id && v.snapshot.documentVersion === dv && (v.snapshot.body ?? null) !== (draft.body ?? ''))) {
        throw new Fail(422, 'CONTENT_INCOMPLETE', 'Текст изменился – нужна новая версия документа', { fields: [{ field: 'documentVersion', code: 'REUSED' }] });
      }
      row.col.documentVersion = dv;
    }
    if (row.type === 'game' && Number.isInteger(draft.sortOrder)) row.col.sortOrder = draft.sortOrder;
  }

  const command = (name: string, run: (s: Staffish, req: FastifyRequest) => { status: number; body: unknown }) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const s = d.current(req);
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!key) throw new Fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key');
      const scope = `${s.id}:${name}:${key}`;
      const saved = replays.get(scope);
      if (saved) return reply.header('idempotent-replay', 'true').code(saved.status).send(saved.body);
      const r = run(s, req);
      replays.set(scope, r);
      return reply.code(r.status).send(r.body);
    } catch (e) {
      return send(reply, e);
    }
  };
  const read = (run: (s: Staffish, req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return run(d.current(req), req);
    } catch (e) {
      return send(reply, e);
    }
  };
  const params = (req: FastifyRequest) => ({ ...(req.params as Rec), ...(req.query as Rec) }) as Record<string, string>;

  /** entityActionRoutes сервера: draft, publish, unpublish, rollback и (где есть) archive. resolve – строка сущности (страницы создаются при первом обращении). */
  function actions(prefix: string, type: EntityType, resolve: (s: Staffish, p: Record<string, string>) => Row, opts: { archive?: boolean } = {}) {
    app.put(`${P}${prefix}/draft`, command(`${type}.save_draft`, (s, req) => {
      const b = strict(req.body, { rowVersion: rv, draft: () => true }, ['rowVersion']);
      const row = resolve(s, params(req));
      const draft = parseDraft(type, b.draft);
      assertEdit(s, row, draft);
      if (row.status === 'archived') throw statusConflict(row.status, 'save_draft');
      checkVersion(row, b.rowVersion);
      usable(refsOf(type, draft));
      row.draft = draft;
      row.rowVersion += 1;
      touch(row, s);
      return { status: 200, body: dto(row) };
    }));
    app.post(`${P}${prefix}/publish`, command(`${type}.publish`, (s, req) => {
      const b = strict(req.body, { rowVersion: rv, reason: reasonT }, ['rowVersion']);
      const row = resolve(s, params(req));
      const draft = parseDraft(type, row.draft);
      assertPublish(s, row, draft);
      if (row.status === 'archived') throw statusConflict(row.status, 'publish');
      checkVersion(row, b.rowVersion);
      const issues = complete(row, draft);
      const refs = refsOf(type, draft);
      for (const r of refs) {
        const m = cms.media.find((x) => x.id === r.mediaId);
        if (!m) issues.push({ field: r.field, code: 'MEDIA_MISSING' });
        else if (r.altRequired && m.mime === 'application/pdf') issues.push({ field: r.field, code: 'MEDIA_NOT_IMAGE' });
      }
      if (issues.length) throw new Fail(422, 'CONTENT_INCOMPLETE', 'Заполните обязательные поля', { fields: issues });
      const noAlt = refs.filter((r) => r.altRequired && !str(cms.media.find((x) => x.id === r.mediaId)?.alt));
      if (noAlt.length) throw new Fail(422, 'MEDIA_ALT_REQUIRED', 'Заполните описание картинки (alt)', { fields: noAlt.map((r) => ({ field: r.field, mediaId: r.mediaId })) });
      applyLive(row, draft);
      const snapshot = { ...draft, media: frozen(draft, type) };
      const v = newVersion(row, s, snapshot, 'publish', str(b.reason) || null, null);
      row.status = 'published';
      row.liveVersionId = v.id;
      row.rowVersion += 1;
      return { status: 200, body: { ...dto(row), versionNo: v.versionNo, versionId: v.id } };
    }));
    app.post(`${P}${prefix}/unpublish`, command(`${type}.unpublish`, (s, req) => {
      const b = strict(req.body, { reason: reasonT }, ['reason']);
      const row = resolve(s, params(req));
      assertPublish(s, row, row.draft);
      reasonOf(b.reason);
      if (row.status === 'unpublished') return { status: 200, body: dto(row) };
      if (row.status !== 'published') throw statusConflict(row.status, 'unpublish');
      row.status = 'unpublished';
      row.rowVersion += 1;
      return { status: 200, body: dto(row) };
    }));
    app.post(`${P}${prefix}/rollback`, command(`${type}.rollback`, (s, req) => {
      const b = strict(req.body, { versionId: (v) => typeof v === 'string' && /^\d{1,18}$/.test(v), rowVersion: rv, reason: reasonT }, ['versionId', 'rowVersion', 'reason']);
      const row = resolve(s, params(req));
      assertPublish(s, row, row.draft);
      const reason = reasonOf(b.reason);
      if (row.status === 'archived') throw statusConflict(row.status, 'rollback');
      checkVersion(row, b.rowVersion);
      const source = cms.versions.find((v) => v.id === b.versionId && v.entityType === type && v.entityId === row.id);
      if (!source) throw notFound();
      const draft: Rec = { ...source.snapshot };
      delete draft.media;
      assertPublish(s, row, draft);
      const v = newVersion(row, s, { ...source.snapshot }, 'rollback_publish', reason, source.id);
      row.draft = draft;
      touch(row, s);
      applyLive(row, draft);
      row.status = 'published';
      row.liveVersionId = v.id;
      row.rowVersion += 1;
      return { status: 200, body: { ...dto(row), versionNo: v.versionNo, versionId: v.id } };
    }));
    if (opts.archive) {
      app.post(`${P}${prefix}/archive`, command(`${type}.archive`, (s, req) => {
        const b = strict(req.body, { reason: reasonT }, ['reason']);
        const row = resolve(s, params(req));
        assertPublish(s, row, row.draft);
        reasonOf(b.reason);
        if (row.status === 'archived') return { status: 200, body: dto(row) };
        if (row.status === 'published') throw statusConflict(row.status, 'archive');
        row.status = 'archived';
        row.archivedAt = new Date().toISOString();
        row.rowVersion += 1;
        return { status: 200, body: dto(row) };
      }));
    }
  }
  const versionsOf = (type: EntityType, row: Row | undefined): { items: VersionDto[] } => ({
    items: row ? cms.versions.filter((v) => v.entityType === type && v.entityId === row.id).sort((a, b) => b.versionNo - a.versionNo) : [],
  });

  // ---- №213–218 публикации

  app.get(`${P}/content/publications`, read((s, req) => {
    assertRole(s, 'content.view');
    const q = req.query as Record<string, string | undefined>;
    const issues = [];
    if (q.type && !PUBLICATION_TYPES.includes(q.type)) issues.push({ path: 'type', message: 'неверное значение' });
    if (q.status && !STATUSES.includes(q.status)) issues.push({ path: 'status', message: 'неверное значение' });
    if (q.q && q.q.length > 200) issues.push({ path: 'q', message: 'не длиннее 200' });
    if (q.sort && !['updated', 'created'].includes(q.sort)) issues.push({ path: 'sort', message: 'неверное значение' });
    if (issues.length) throw invalid(issues);
    const z = d.zone(s);
    const list = cms.rows.filter((r) => {
      if (r.type !== 'publication') return false;
      const sc = r.draft.scope as Scope;
      if (q.type && r.col.pubType !== q.type) return false;
      if (q.status && r.status !== q.status) return false;
      if (q.cityId && !(sc.type === 'city' && sc.cityIds.includes(q.cityId))) return false;
      if (q.branchId && !(sc.type === 'branch' && sc.branchIds.includes(q.branchId))) return false;
      if (q.q && !String(r.draft.title ?? '').toLowerCase().includes(q.q.toLowerCase())) return false;
      if (!z.network && !(sc.type === 'network' || (sc.type === 'city' && sc.cityIds.some((c) => z.cityIds.includes(c))) || (sc.type === 'branch' && sc.branchIds.some((b) => z.branchIds.includes(b))))) return false;
      return true;
    });
    const key = q.sort === 'created' ? 'createdAt' : 'draftUpdatedAt';
    list.sort((a, b) => b[key].localeCompare(a[key]) || b.id.localeCompare(a.id));
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const from = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) : 0;
    if (Number.isNaN(from)) throw invalid([{ path: 'cursor', message: 'неверный курсор' }]);
    const page = list.slice(from, from + limit);
    return { items: page.map((r) => ({ ...dto(r), id: r.id, type: r.col.pubType as PublicationType, slug: (r.col.slug as string | undefined) ?? null, allowedActions: allowed(s, r) })), nextCursor: from + limit < list.length ? Buffer.from(String(from + limit)).toString('base64url') : null } satisfies { items: PublicationDto[]; nextCursor: string | null };
  }));

  app.post(`${P}/content/publications`, command('publication.create', (s, req) => {
    const b = strict(req.body, { type: (v) => PUBLICATION_TYPES.includes(String(v)), draft: () => true }, ['type']);
    const draft = parseDraft('publication', b.draft);
    assertScope(s, draft.scope as Scope, 'content.draft.edit');
    for (const t of targets(draft.scope as Scope)) if ('branchId' in t ? !d.branches().some((x) => x.id === t.branchId) : !d.branches().some((x) => x.cityId === t.cityId)) throw notFound();
    usable(refsOf('publication', draft));
    const row = mkRow(randomUUID(), 'publication', draft, { pubType: b.type }, new Date().toISOString());
    row.draftUpdatedBy = s.id;
    cms.rows.push(row);
    return { status: 201, body: { ...dto(row), type: b.type } };
  }));

  app.get(`${P}/content/publications/:id`, read((s, req) => {
    const row = find('publication', (req.params as { id: string }).id);
    viewPublication(s, row);
    const live = row.liveVersionId ? (cms.versions.find((v) => v.id === row.liveVersionId)?.snapshot ?? null) : null;
    return { ...dto(row), id: row.id, type: row.col.pubType as PublicationType, slug: (row.col.slug as string | undefined) ?? null, live, allowedActions: allowed(s, row) } satisfies PublicationDto;
  }));
  const pubOf = (_s: Staffish, p: Record<string, string>) => find('publication', p.id ?? '');
  actions('/content/publications/:id', 'publication', pubOf, { archive: true });
  app.get(`${P}/content/publications/:id/versions`, read((s, req) => {
    const row = find('publication', (req.params as { id: string }).id);
    viewPublication(s, row);
    return versionsOf('publication', row);
  }));

  // №233 токен предпросмотра: полезная нагрузка base64url + подпись (у мока – заглушка). CRM сверяет staffId с текущим сотрудником.
  const TABLE: Record<string, EntityType> = { publication: 'publication', game: 'game', room_page: 'room_page', branch_page: 'branch_page', content_page: 'content_page', home_block: 'home_block' };
  app.post(`${P}/content/:entityType/:id/preview-token`, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
    const s = d.current(req);
    const p = req.params as { entityType: string; id: string };
    const type = TABLE[p.entityType];
    if (!type) throw notFound();
    const b = strict(req.body, { branchId: (v) => typeof v === 'string' }, []);
    const row = find(type, p.id);
    assertRole(s, 'content.preview');
    if (type === 'publication') {
      const t = targets(row.draft.scope as Scope);
      if (t.length > 0 && !t.some((x) => canT(s, 'content.preview', x))) throw notFound();
    } else if (type === 'branch_page' && !canT(s, 'content.preview', { branchId: String(row.col.branchId) })) throw notFound();
    else if (type === 'room_page' && !canT(s, 'content.preview', { branchId: branchOfRoom(String(row.col.roomId)) })) throw notFound();
    else if ((type === 'content_page' || type === 'home_block') && typeof row.col.cityId === 'string' && !canT(s, 'content.preview', { cityId: row.col.cityId })) throw notFound();
    if (typeof b.branchId === 'string' && !canT(s, 'content.preview', { branchId: b.branchId })) throw notFound();
    const payload = { entityType: type, entityId: row.id, draftRowVersion: row.rowVersion, staffId: s.id, ...(b.branchId ? { branchId: b.branchId } : {}), exp: Date.now() + 600_000 };
    const token = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.mock-signature`;
    return reply.code(201).send({ token, previewPath: `/content/preview/${token}` });
    } catch (e) {
      return send(reply, e);
    }
  });

  // ---- №236–238 слаги

  const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  app.get(`${P}/content/slug-suggest`, read((s, req) => {
    assertRole(s, 'content.view');
    const q = req.query as Record<string, string | undefined>;
    if (!['game', 'publication'].includes(String(q.type)) || !q.title || q.title.length > 300) throw invalid([{ path: 'title', message: 'неверное значение' }]);
    let out = '';
    for (const w of q.title.toLowerCase().match(/[a-zа-яё0-9]+/g) ?? []) {
      if (/^[а-яё]{1,2}$/.test(w)) continue;
      const latin = [...w].map((ch) => TR[ch] ?? ch).join('');
      if (!latin) continue;
      const next = out ? `${out}-${latin}` : latin;
      if (next.length > 90) break;
      out = next;
    }
    return { slug: out };
  }));
  app.get(`${P}/content/slug-check`, read((s, req) => {
    assertRole(s, 'content.view');
    const q = req.query as Record<string, string | undefined>;
    const type = String(q.entityType);
    if (!(type in SLUG_MAX) || typeof q.slug !== 'string' || q.slug.length > 200 || (q.excludeId && !UUID.test(q.excludeId))) throw invalid([{ path: 'slug', message: 'неверное значение' }]);
    const slug = q.slug;
    if (!SLUG_RE.test(slug) || slug.length > SLUG_MAX[type]!) return { ok: false, code: 'SLUG_INVALID' };
    const parentCol = type === 'publication' ? 'pubType' : 'direction';
    const taken = (x: string) => (type === 'publication' || type === 'game') && cms.rows.some((o) => o.type === type && o.id !== q.excludeId && String(o.col[parentCol]) === (q.parent ?? '') && o.col.slug === x);
    if (taken(slug)) {
      let n = 2;
      while (taken(`${slug}-${n}`)) n += 1;
      return { ok: false, code: 'SLUG_TAKEN', suggestion: `${slug}-${n}` };
    }
    return cms.history.some((h) => h.entityType === type && h.parentKey === (q.parent ?? '') && h.oldSlug === slug && h.entityId !== q.excludeId) ? { ok: true, code: 'SLUG_IN_HISTORY' } : { ok: true };
  }));
  app.get(`${P}/seo/history`, read((s, req) => {
    assertRole(s, 'content.view');
    const q = req.query as Record<string, string | undefined>;
    if (!(String(q.entityType) in SLUG_MAX) || !UUID.test(String(q.entityId))) throw invalid([{ path: 'entityId', message: 'неверное значение' }]);
    return { items: cms.history.filter((h) => h.entityType === q.entityType && h.entityId === q.entityId).reverse().map((h) => ({ oldSlug: h.oldSlug, createdAt: h.createdAt })) };
  }));

  // ---- №219–220 игры

  app.get(`${P}/content/games`, read((s, req) => {
    assertRole(s, 'content.view');
    const q = req.query as Record<string, string | undefined>;
    if ((q.direction && !DIRECTIONS.includes(q.direction)) || (q.status && !STATUSES.includes(q.status))) throw invalid([{ path: 'direction', message: 'неверное значение' }]);
    const list = cms.rows.filter((r) => r.type === 'game' && (!q.direction || r.col.direction === q.direction) && (!q.status || r.status === q.status));
    list.sort((a, b) => Number(a.col.sortOrder ?? 0) - Number(b.col.sortOrder ?? 0) || a.id.localeCompare(b.id));
    return { items: list.map((g) => ({ ...dto(g), direction: g.col.direction, slug: g.col.slug ?? null })) };
  }));
  app.post(`${P}/content/games`, command('game.create', (s, req) => {
    const b = strict(req.body, { direction: (v) => DIRECTIONS.includes(String(v)), draft: () => true }, ['direction']);
    assertCan(s, 'content.network.manage', 'network');
    const draft = parseDraft('game', b.draft);
    usable(refsOf('game', draft));
    const row = mkRow(randomUUID(), 'game', draft, { direction: b.direction, sortOrder: 0 }, new Date().toISOString());
    row.draftUpdatedBy = s.id;
    cms.rows.push(row);
    return { status: 201, body: { ...dto(row), direction: b.direction } };
  }));
  app.get(`${P}/content/games/:id/draft`, read((s, req) => {
    assertRole(s, 'content.view');
    const row = find('game', (req.params as { id: string }).id);
    return { ...dto(row), direction: row.col.direction, slug: row.col.slug ?? null, branches: [...row.branches].map(([branchId, x]) => ({ branchId, available: x.available, note: x.note })) };
  }));
  app.get(`${P}/content/games/:id/versions`, read((s, req) => {
    assertRole(s, 'content.view');
    return versionsOf('game', find('game', (req.params as { id: string }).id));
  }));
  actions('/content/games/:id', 'game', (_s, p) => find('game', p.id ?? ''), { archive: true });
  app.put(`${P}/content/games/:id/branches/:branchId`, command('game.availability', (s, req) => {
    const b = strict(req.body, { available: (v) => typeof v === 'boolean', note: (v) => v === null || (typeof v === 'string' && v.length <= 120) }, ['available']);
    const p = req.params as { id: string; branchId: string };
    if (!d.branches().some((x) => x.id === p.branchId)) throw notFound();
    assertCan(s, 'content.catalog.availability', { branchId: p.branchId });
    const row = find('game', p.id);
    const note = str(b.note) || null;
    row.branches.set(p.branchId, { available: b.available as boolean, note });
    return { status: 200, body: { gameId: row.id, branchId: p.branchId, available: b.available, note } };
  }));

  // ---- №221–222 страницы комнат и филиалов

  const roomRow = (roomId: string) => cms.rows.find((r) => r.type === 'room_page' && r.col.roomId === roomId);
  app.get(`${P}/content/rooms/:roomId/draft`, read((s, req) => {
    const { roomId } = req.params as { roomId: string };
    assertCan(s, 'content.view', { branchId: branchOfRoom(roomId) });
    const row = roomRow(roomId);
    return row ? dto(row) : emptyDraft;
  }));
  app.get(`${P}/content/rooms/:roomId/versions`, read((s, req) => {
    const { roomId } = req.params as { roomId: string };
    assertCan(s, 'content.view', { branchId: branchOfRoom(roomId) });
    return versionsOf('room_page', roomRow(roomId));
  }));
  actions('/content/rooms/:roomId', 'room_page', (s, p) => {
    const roomId = p.roomId ?? '';
    const branchId = branchOfRoom(roomId);
    assertCan(s, 'content.view', { branchId });
    const found = roomRow(roomId);
    if (found) return found;
    assertCan(s, 'content.draft.edit', { branchId });
    const row = mkRow(randomUUID(), 'room_page', {}, { roomId }, new Date().toISOString());
    cms.rows.push(row);
    return row;
  });
  const branchRow = (branchId: string) => cms.rows.find((r) => r.type === 'branch_page' && r.col.branchId === branchId);
  const branchParam = (raw: unknown) => {
    const { branchId } = raw as { branchId: string };
    if (!d.branches().some((b) => b.id === branchId)) throw notFound();
    return branchId;
  };
  app.get(`${P}/content/branches/:branchId/draft`, read((s, req) => {
    const branchId = branchParam(req.params);
    assertCan(s, 'content.view', { branchId });
    const row = branchRow(branchId);
    return row ? dto(row) : emptyDraft;
  }));
  app.get(`${P}/content/branches/:branchId/versions`, read((s, req) => {
    const branchId = branchParam(req.params);
    assertCan(s, 'content.view', { branchId });
    return versionsOf('branch_page', branchRow(branchId));
  }));
  actions('/content/branches/:branchId', 'branch_page', (s, p) => {
    const branchId = branchParam(p);
    assertCan(s, 'content.view', { branchId });
    const found = branchRow(branchId);
    if (found) return found;
    assertCan(s, 'content.draft.edit', { branchId });
    const row = mkRow(randomUUID(), 'branch_page', {}, { branchId }, new Date().toISOString());
    cms.rows.push(row);
    return row;
  });

  // ---- №223 страницы по ключу

  const pageKey = (key: string) => {
    if (!PAGE_KEYS.includes(key)) throw new Fail(404, 'PAGE_KEY_UNKNOWN', 'Такой страницы нет', { key });
  };
  const viewCity = (s: Staffish, cityId: unknown) => {
    assertRole(s, 'content.view');
    if (typeof cityId === 'string' && !canT(s, 'content.view', { cityId })) throw notFound();
  };
  const pageRow = (key: string, cityId: string | null) => cms.rows.find((r) => r.type === 'content_page' && r.col.key === key && (r.col.cityId ?? null) === cityId);
  app.get(`${P}/content/pages/:key/draft`, read((s, req) => {
    const { key } = req.params as { key: string };
    pageKey(key);
    const cityId = (req.query as Rec).cityId as string | undefined;
    viewCity(s, cityId);
    const row = pageRow(key, cityId ?? null);
    return row ? { ...dto(row), key, cityId: row.col.cityId ?? null } : { ...emptyDraft, key, cityId: cityId ?? null };
  }));
  app.get(`${P}/content/pages/:key/versions`, read((s, req) => {
    const { key } = req.params as { key: string };
    pageKey(key);
    const cityId = (req.query as Rec).cityId as string | undefined;
    viewCity(s, cityId);
    return versionsOf('content_page', pageRow(key, cityId ?? null));
  }));
  actions('/content/pages/:key', 'content_page', (s, p) => {
    const key = p.key ?? '';
    pageKey(key);
    assertCan(s, isLegal(key) ? 'content.legal.publish' : 'content.network.manage', 'network');
    const cityId = p.cityId ?? null;
    if (cityId !== null && isLegal(key)) throw contentInvalid('cityId', 'только сетевая страница');
    const found = pageRow(key, cityId);
    if (found) return found;
    if (cityId !== null && !d.branches().some((b) => b.cityId === cityId)) throw notFound();
    const row = mkRow(randomUUID(), 'content_page', {}, { key, cityId }, new Date().toISOString());
    cms.rows.push(row);
    return row;
  });

  // ---- №228 блоки главной

  app.get(`${P}/content/home-blocks`, read((s, req) => {
    const cityId = (req.query as Rec).cityId as string | undefined;
    viewCity(s, cityId);
    const list = cms.rows.filter((r) => r.type === 'home_block' && (r.col.cityId ?? null) === (cityId ?? null)).sort((a, b) => Number(a.col.sortOrder) - Number(b.col.sortOrder) || a.id.localeCompare(b.id));
    return { items: list.map((b) => ({ ...dto(b), blockType: b.col.blockType, cityId: b.col.cityId ?? null, sortOrder: b.col.sortOrder })) };
  }));
  app.put(`${P}/content/home-blocks`, command('home_block.save', (s, req) => {
    const b = strict(req.body, { blockType: (v) => BLOCK_TYPES.includes(String(v)), cityId: (v) => v === null || typeof v === 'string', rowVersion: rv, draft: () => true }, ['blockType']);
    const cityId = (b.cityId as string | null | undefined) ?? null;
    blockRight(s, cityId);
    const found = cms.rows.find((r) => r.type === 'home_block' && r.col.blockType === b.blockType && (r.col.cityId ?? null) === cityId);
    if (!found) {
      const draft = parseDraft('home_block', b.draft);
      if (draft.blockType !== b.blockType) throw contentInvalid('blockType', 'не совпадает с типом блока');
      usable(refsOf('home_block', draft));
      const row = mkRow(randomUUID(), 'home_block', draft, { blockType: b.blockType, cityId, sortOrder: BLOCK_TYPES.indexOf(String(b.blockType)) }, new Date().toISOString());
      row.draftUpdatedBy = s.id;
      cms.rows.push(row);
      return { status: 201, body: dto(row) };
    }
    if (b.rowVersion === undefined) throw new Fail(409, 'VERSION_CONFLICT', 'Блок уже есть, обновите страницу', { current: dto(found) });
    const draft = parseDraft('home_block', b.draft);
    assertEdit(s, found, draft);
    if (found.status === 'archived') throw statusConflict(found.status, 'save_draft');
    checkVersion(found, b.rowVersion);
    usable(refsOf('home_block', draft));
    found.draft = draft;
    found.rowVersion += 1;
    touch(found, s);
    return { status: 200, body: dto(found) };
  }));
  app.put(`${P}/content/home-blocks/order`, command('home_block.order', (s, req) => {
    const b = strict(req.body, { cityId: (v) => v === null || typeof v === 'string', ids: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 50 && v.every((x) => typeof x === 'string' && UUID.test(x)) }, ['ids']);
    const cityId = (b.cityId as string | null | undefined) ?? null;
    blockRight(s, cityId);
    const ids = b.ids as string[];
    const level = cms.rows.filter((r) => r.type === 'home_block' && (r.col.cityId ?? null) === cityId && ids.includes(r.id));
    if (level.length !== new Set(ids).size) throw notFound();
    ids.forEach((id, i) => {
      const r = level.find((x) => x.id === id)!;
      r.col.sortOrder = i;
      r.rowVersion += 1;
    });
    return { status: 200, body: { ids } };
  }));
  app.get(`${P}/content/home-blocks/:id/draft`, read((s, req) => {
    const row = find('home_block', (req.params as { id: string }).id);
    viewCity(s, row.col.cityId);
    return { ...dto(row), blockType: row.col.blockType, cityId: row.col.cityId ?? null, sortOrder: row.col.sortOrder };
  }));
  app.get(`${P}/content/home-blocks/:id/versions`, read((s, req) => {
    const row = find('home_block', (req.params as { id: string }).id);
    viewCity(s, row.col.cityId);
    return versionsOf('home_block', row);
  }));
  actions('/content/home-blocks/:id', 'home_block', (_s, p) => find('home_block', p.id ?? ''));

  registerMedia(app, P, { command, read, assertRole, strict, rv });
}
