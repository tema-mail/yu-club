// S4-39. API CRM каталога и страниц K11 №219–223, №228 (K22 §13): игры и доступность, страницы комнат, филиалов и страницы по ключу, блоки главной.
// Строка страницы создаётся при первом сохранении (адрес фиксирован, отдельного «создать» нет). Права – в определениях сущностей и ensure-функциях.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { assertCan } from '../../core/permissions.ts';
import { blockDef, BLOCK_TYPES, ensureBlock, reorderBlocks } from './blocks.ts';
import { uuid } from './common.ts';
import { gameDef, GAME_DIRECTIONS, setGameBranch } from './games.ts';
import { assertRole } from './media.ts';
import { assertPageKey, branchPageDef, ensureBranchPage, ensurePage, ensureRoomPage, pageDef, roomPageDef } from './pages.ts';
import { commandRunner, entityActionRoutes, parseInput, type ContentCrmDeps } from './routes.crm.publications.ts';
import { createEntity, draftDto, listVersions, loadEntity, saveDraft, type EntityRow, type EntityType } from './versions.ts';

const cityQuery = z.object({ cityId: uuid.optional() });
const availabilityBody = z.strictObject({ available: z.boolean(), note: z.string().max(120).nullable().optional() });
const blockBody = z.strictObject({ blockType: z.enum(BLOCK_TYPES), cityId: uuid.nullable().optional(), rowVersion: z.number().int().min(1).optional(), draft: z.unknown() });
const orderBody = z.strictObject({ cityId: uuid.nullable().optional(), ids: z.array(uuid).min(1).max(50) });

/** Ещё нет строки: экран получает пустой черновик с rowVersion = 1 – первое сохранение создаст её (чтение ничего не пишет). */
const emptyDraft = { id: null, status: 'draft', draft: {}, rowVersion: 1, liveVersionId: null };

export async function catalogCrmRoutes(app: FastifyInstance, deps: ContentCrmDeps): Promise<void> {
  const command = commandRunner(deps);
  const db: Db = deps.pool;

  async function versionsOf(type: EntityType, row: EntityRow | undefined) {
    return { items: row ? await listVersions(db, type, row.id) : [] };
  }

  // ---- №219 игры

  app.get('/content/games', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const q = parseInput(z.object({ direction: z.enum(GAME_DIRECTIONS).optional(), status: z.enum(['draft', 'published', 'unpublished', 'archived']).optional() }), request.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.direction) {
      params.push(q.direction);
      where.push(`direction = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    const r = await db.query<EntityRow>(`SELECT * FROM ${gameDef.table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_order, id LIMIT 500`, params);
    return { items: r.rows.map((g) => ({ ...draftDto(g), direction: g.direction, slug: g.slug })) };
  });

  app.post('/content/games', async (request, reply) => {
    const body = parseInput(z.strictObject({ direction: z.enum(GAME_DIRECTIONS), draft: z.unknown() }), request.body);
    return command(request, reply, 'game.create', body, async (tx, access, meta, clock) => {
      assertCan(access, 'content.network.manage', { network: true });
      const row = await createEntity(tx, access, gameDef, { direction: body.direction }, body.draft, meta, clock);
      return { status: 201, body: { ...draftDto(row), direction: row.direction } };
    });
  });

  app.get('/content/games/:id/draft', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const row = await loadEntity(db, gameDef.table, (request.params as { id: string }).id);
    const branches = await db.query<{ branch_id: string; available: boolean; note: string | null }>(`SELECT branch_id, available, note FROM app.content_game_branches WHERE game_id = $1`, [row.id]);
    return { ...draftDto(row), direction: row.direction, slug: row.slug, branches: branches.rows.map((b) => ({ branchId: b.branch_id, available: b.available, note: b.note })) };
  });

  app.get('/content/games/:id/versions', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    return versionsOf('game', await loadEntity(db, gameDef.table, (request.params as { id: string }).id));
  });

  entityActionRoutes(app, deps, gameDef, '/content/games/:id', async (_db, params) => (params as { id: string }).id, { archive: true });

  // №220 доступность игры в филиале
  app.put('/content/games/:id/branches/:branchId', async (request, reply) => {
    const body = parseInput(availabilityBody, request.body);
    const p = request.params as { id: string; branchId: string };
    if (!uuid.safeParse(p.branchId).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return command(request, reply, 'game.availability', body, async (tx, access, meta, clock) => ({
      status: 200,
      body: await setGameBranch(tx, access, p.id, p.branchId, { available: body.available, note: body.note ?? null }, meta, clock),
    }));
  });

  // ---- №221 страница комнаты

  async function roomRow(roomId: string): Promise<EntityRow | undefined> {
    if (!uuid.safeParse(roomId).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return (await db.query<EntityRow>(`SELECT * FROM ${roomPageDef.table} WHERE room_id = $1`, [roomId])).rows[0];
  }
  async function roomBranch(roomId: string): Promise<string> {
    const r = uuid.safeParse(roomId).success ? await db.query<{ branch_id: string }>(`SELECT branch_id FROM app.rooms WHERE id = $1`, [roomId]) : { rows: [] };
    if (!r.rows[0]) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return r.rows[0].branch_id;
  }

  app.get('/content/rooms/:roomId/draft', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const { roomId } = request.params as { roomId: string };
    assertCan(access, 'content.view', { branchId: await roomBranch(roomId) });
    const row = await roomRow(roomId);
    return row ? draftDto(row) : emptyDraft;
  });
  app.get('/content/rooms/:roomId/versions', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const { roomId } = request.params as { roomId: string };
    assertCan(access, 'content.view', { branchId: await roomBranch(roomId) });
    return versionsOf('room_page', await roomRow(roomId));
  });
  entityActionRoutes(app, deps, roomPageDef, '/content/rooms/:roomId', async (tx, params, access, meta, clock) => (await ensureRoomPage(tx, access, (params as { roomId: string }).roomId, meta, clock)).id);

  // ---- №222 страница филиала

  async function branchRow(branchId: string): Promise<EntityRow | undefined> {
    return (await db.query<EntityRow>(`SELECT * FROM ${branchPageDef.table} WHERE branch_id = $1`, [branchId])).rows[0];
  }
  const branchParam = (raw: unknown) => {
    const { branchId } = raw as { branchId: string };
    if (!uuid.safeParse(branchId).success) throw new AppError('NOT_FOUND', 404, 'Не найдено');
    return branchId;
  };

  app.get('/content/branches/:branchId/draft', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const branchId = branchParam(request.params);
    assertCan(access, 'content.view', { branchId });
    const row = await branchRow(branchId);
    return row ? draftDto(row) : emptyDraft;
  });
  app.get('/content/branches/:branchId/versions', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    const branchId = branchParam(request.params);
    assertCan(access, 'content.view', { branchId });
    return versionsOf('branch_page', await branchRow(branchId));
  });
  entityActionRoutes(app, deps, branchPageDef, '/content/branches/:branchId', async (tx, params, access, meta, clock) => (await ensureBranchPage(tx, access, (params as { branchId: string }).branchId, meta, clock)).id);

  // ---- №223 страница по ключу

  async function pageRow(key: string, cityId: string | null): Promise<EntityRow | undefined> {
    return (await db.query<EntityRow>(`SELECT * FROM ${pageDef.table} WHERE key = $1 AND city_id IS NOT DISTINCT FROM $2::uuid`, [key, cityId])).rows[0];
  }
  app.get('/content/pages/:key/draft', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const { key } = request.params as { key: string };
    assertPageKey(key);
    const { cityId } = parseInput(cityQuery, request.query);
    const row = await pageRow(key, cityId ?? null);
    return row ? { ...draftDto(row), key, cityId: row.city_id } : { ...emptyDraft, key, cityId: cityId ?? null };
  });
  app.get('/content/pages/:key/versions', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const { key } = request.params as { key: string };
    assertPageKey(key);
    const { cityId } = parseInput(cityQuery, request.query);
    return versionsOf('content_page', await pageRow(key, cityId ?? null));
  });
  entityActionRoutes(app, deps, pageDef, '/content/pages/:key', async (tx, params, access, meta, clock) => {
    const p = params as { key: string; cityId?: string };
    return (await ensurePage(tx, access, p.key, p.cityId ?? null, meta, clock)).id;
  });

  // ---- №228 блоки главной

  app.get('/content/home-blocks', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    const { cityId } = parseInput(cityQuery, request.query);
    const r = await db.query<EntityRow>(`SELECT * FROM ${blockDef.table} WHERE city_id IS NOT DISTINCT FROM $1::uuid ORDER BY sort_order, id`, [cityId ?? null]);
    return { items: r.rows.map((b) => ({ ...draftDto(b), blockType: b.block_type, cityId: b.city_id, sortOrder: b.sort_order })) };
  });

  // Создать блок типа или сохранить его черновик (тип на уровне один): у существующего нужен rowVersion.
  app.put('/content/home-blocks', async (request, reply) => {
    const body = parseInput(blockBody, request.body);
    return command(request, reply, 'home_block.save', body, async (tx, access, meta, clock) => {
      const { row, created } = await ensureBlock(tx, access, { blockType: body.blockType, cityId: body.cityId ?? null, draft: body.draft }, meta, clock);
      if (created) return { status: 201, body: draftDto(row) };
      if (body.rowVersion === undefined) throw new AppError('VERSION_CONFLICT', 409, 'Блок уже есть, обновите страницу', { current: draftDto(row) });
      return { status: 200, body: draftDto(await saveDraft(tx, access, blockDef, row.id, { rowVersion: body.rowVersion, draft: body.draft }, meta, clock)) };
    });
  });

  app.put('/content/home-blocks/order', async (request, reply) => {
    const body = parseInput(orderBody, request.body);
    return command(request, reply, 'home_block.order', body, async (tx, access, meta, clock) => {
      await reorderBlocks(tx, access, { cityId: body.cityId ?? null, ids: body.ids }, meta, clock);
      return { status: 200, body: { ids: body.ids } };
    });
  });

  app.get('/content/home-blocks/:id/versions', async (request, reply) => {
    const { access } = await deps.authenticate(request, reply);
    assertRole(access, 'content.view');
    return versionsOf('home_block', await loadEntity(db, blockDef.table, (request.params as { id: string }).id));
  });

  entityActionRoutes(app, deps, blockDef, '/content/home-blocks/:id', async (_db, params) => (params as { id: string }).id);
}
